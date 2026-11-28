// The tickets sync loop (pure: xstate and types only). One cycle resolves who the host acts as,
// reads Linear (issues, notifications), then GitHub (PR probes, facts), then reconciles membership
// when due; it waits about two minutes (jittered) and runs again. The runtime (`actor.ts` over
// `service.ts`) provides the steps; tests provide stubs.
//
//   idle -> syncing (identify -> linear -> github -> reconcile?) -> waiting -> syncing ...
//   syncing -> backingOff (exponential, at least what the provider asked) -> syncing
//   syncing -> identityChanged (wipe) -> idle;  syncing -> off (no Linear key) -> syncing (retry)
//
// A forced `sync.now` while syncing becomes one follow-up cycle; forced cycles start at least
// `cooldownMs` after the previous one ended; a backoff is never cut short.

import { assign, fromPromise, setup } from "xstate";

export interface TicketsSyncTiming {
  /** The pause between cycles before jitter (120 s). */
  readonly intervalMs: number;
  /** +- this share of the interval (0.1). */
  readonly jitter: number;
  /** A forced cycle starts no sooner than this after the last one ended (30 s). */
  readonly cooldownMs: number;
  /** With no Linear key, how often to look again. */
  readonly offRetryMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** In [0, 1): the jitter draw (Math.random at runtime). */
  readonly random: () => number;
}

export const TICKETS_SYNC_TIMING: Omit<TicketsSyncTiming, "random"> = {
  intervalMs: 120_000,
  jitter: 0.1,
  cooldownMs: 30_000,
  offRetryMs: 10 * 60_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 30 * 60_000,
};

export interface TicketsSyncInput {
  readonly timing: TicketsSyncTiming;
}

/** `same`: carry on; `changed`: a different (or no longer any) account; `off`: no Linear key. */
export interface IdentifyOutput {
  readonly kind: "same" | "changed" | "off";
}

export interface LinearStepOutput {
  readonly reconcileDue: boolean;
}

export interface TicketsSyncContext {
  readonly timing: TicketsSyncTiming;
  /** Failed cycles in a row. */
  readonly attempt: number;
  readonly backoffMs: number;
  /** A `sync.now` arrived while syncing or cooling down. */
  readonly followUp: boolean;
  readonly reconcileDue: boolean;
  readonly lastError: string | null;
}

export type TicketsSyncEvent = { readonly type: "sync.now" };

/** What a failed step threw: `waitMs` when the provider said how long to wait (RateLimited). */
interface StepError {
  readonly message?: unknown;
  readonly waitMs?: unknown;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Exponential from `backoffBaseMs`, capped, and never shorter than the provider's own wait. */
export function backoffFor(timing: TicketsSyncTiming, attempt: number, error: unknown): number {
  const exp = Math.min(timing.backoffMaxMs, timing.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
  const asked = (error as StepError | null)?.waitMs;
  return typeof asked === "number" && Number.isFinite(asked) ? Math.max(exp, asked) : exp;
}

const failed = {
  target: "#ticketsSync.backingOff",
  actions: { type: "recordFailure", params: ({ event }: { event: { error: unknown } }) => ({ error: event.error }) },
} as const;

export const ticketsSyncMachine = setup({
  types: {
    input: {} as TicketsSyncInput,
    context: {} as TicketsSyncContext,
    events: {} as TicketsSyncEvent,
  },
  actors: {
    // Placeholders; actor.ts provides the real ones, tests stubs.
    /** Resolves the Linear viewer and gh login and compares them with the last cycle's. */
    identify: fromPromise<IdentifyOutput>(() => Promise.reject(new Error("identify not provided"))),
    /** Linear: changed issues (bounded pages, cursor resume), watched keys, notifications. */
    linear: fromPromise<LinearStepOutput>(() => Promise.reject(new Error("linear not provided"))),
    /** GitHub: the batched PR probe, full facts for changed fingerprints. */
    github: fromPromise<null>(() => Promise.reject(new Error("github not provided"))),
    /** Id-only membership pass; tombstones what left. */
    reconcile: fromPromise<null>(() => Promise.reject(new Error("reconcile not provided"))),
    /** Another account: drops every cached issue and PR and the pending approvals. */
    wipe: fromPromise<null>(() => Promise.reject(new Error("wipe not provided"))),
  },
  actions: {
    recordFailure: assign(({ context }, params: { error: unknown }) => {
      const attempt = context.attempt + 1;
      return { attempt, backoffMs: backoffFor(context.timing, attempt, params.error), lastError: errorText(params.error) };
    }),
    recordSuccess: assign({ attempt: 0, lastError: null }),
    recordOff: assign({ lastError: "No Linear key on the host" }),
    markFollowUp: assign({ followUp: true }),
    clearFollowUp: assign({ followUp: false }),
    noteReconcile: assign({ reconcileDue: (_, params: { due: boolean }) => params.due }),
  },
  guards: {
    identityChanged: (_, params: { kind: IdentifyOutput["kind"] }) => params.kind === "changed",
    noKey: (_, params: { kind: IdentifyOutput["kind"] }) => params.kind === "off",
    reconcileDue: ({ context }) => context.reconcileDue,
    followUp: ({ context }) => context.followUp,
  },
  delays: {
    cooldown: ({ context }) => context.timing.cooldownMs,
    /** The rest of a jittered interval after the cooldown. */
    rest: ({ context }) => {
      const t = context.timing;
      const interval = t.intervalMs * (1 - t.jitter + 2 * t.jitter * t.random());
      return Math.max(0, interval - t.cooldownMs);
    },
    backoff: ({ context }) => context.backoffMs,
    offRetry: ({ context }) => context.timing.offRetryMs,
  },
}).createMachine({
  id: "ticketsSync",
  context: ({ input }) => ({ timing: input.timing, attempt: 0, backoffMs: 0, followUp: false, reconcileDue: false, lastError: null }),
  initial: "idle",
  states: {
    idle: { always: "syncing" },
    off: {
      on: { "sync.now": "syncing" },
      after: { offRetry: "syncing" },
    },
    syncing: {
      initial: "identify",
      entry: "clearFollowUp",
      on: { "sync.now": { actions: "markFollowUp" } },
      states: {
        identify: {
          invoke: {
            src: "identify",
            onDone: [
              { guard: { type: "identityChanged", params: ({ event }) => ({ kind: event.output.kind }) }, target: "#ticketsSync.identityChanged" },
              { guard: { type: "noKey", params: ({ event }) => ({ kind: event.output.kind }) }, target: "#ticketsSync.off", actions: "recordOff" },
              { target: "linear" },
            ],
            onError: failed,
          },
        },
        linear: {
          invoke: {
            src: "linear",
            onDone: { target: "github", actions: { type: "noteReconcile", params: ({ event }) => ({ due: event.output.reconcileDue }) } },
            onError: failed,
          },
        },
        github: {
          invoke: {
            src: "github",
            onDone: [{ guard: "reconcileDue", target: "reconcile" }, { target: "done" }],
            onError: failed,
          },
        },
        reconcile: {
          invoke: { src: "reconcile", onDone: "done", onError: failed },
        },
        done: { type: "final" },
      },
      onDone: { target: "waiting", actions: "recordSuccess" },
    },
    waiting: {
      initial: "cooling",
      states: {
        /** Just synced: a `sync.now` waits for the cooldown and runs once. */
        cooling: {
          on: { "sync.now": { actions: "markFollowUp" } },
          after: {
            cooldown: [{ guard: "followUp", target: "#ticketsSync.syncing" }, { target: "resting" }],
          },
        },
        resting: {
          on: { "sync.now": "#ticketsSync.syncing" },
          after: { rest: "#ticketsSync.syncing" },
        },
      },
    },
    backingOff: {
      after: { backoff: "syncing" },
    },
    identityChanged: {
      invoke: { src: "wipe", onDone: "idle", onError: failed },
    },
  },
});
