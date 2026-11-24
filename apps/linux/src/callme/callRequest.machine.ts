// Lifecycle of one "call me when it's done" request (pure: xstate and types only). Isaac asked an
// assistant to ring him when some work settles; the runtime (`service.ts`) provides the actors that
// check and watch that work and the actions that post the thread card, ring the phone and report a
// miss. Only Isaac asks for a call, so nothing here starts one on its own initiative.
//
//   requested -> waiting -> ringing -> connected | missed      (cancelled, expired, rejected end it early)
//
// Work that fails still rings: Isaac asked to hear when it settled, and the greeting says it failed.

import { assign, fromCallback, fromPromise, setup } from "xstate";

/** How the work ended: its status and a short result (the run's last reply, the summary given). */
export interface WorkOutcome {
  readonly status: "done" | "failed";
  readonly result: string;
}

/** The timing a request runs on; every value comes from the host (`DEFAULT_CALL_ME_TIMING`, host.json `callMe`). */
export interface CallRequestTiming {
  /** How long the phone rings (the "is calling" notification stays answerable) before it is a miss. */
  readonly ringMs: number;
  /** How long to wait for the work before giving up. */
  readonly maxWaitMs: number;
}

export interface CallRequestInput {
  readonly id: string;
  /** The assistant that calls (its registry id). */
  readonly agent: string;
  /** What the call is about, as the assistant named the work ("the waterfall options"). */
  readonly about: string;
  readonly timing: CallRequestTiming;
}

export interface CallRequestContext extends CallRequestInput {
  readonly outcome: WorkOutcome | null;
  /** Why it ended early (cancelled, rejected, expired); null otherwise. */
  readonly reason: string | null;
}

export type CallRequestEvent =
  | { readonly type: "work.settled"; readonly outcome: WorkOutcome }
  | { readonly type: "call.answered" }
  | { readonly type: "request.cancel"; readonly reason?: string };

export type CallRequestOutput = Pick<CallRequestContext, "outcome" | "reason">;

export const callRequestMachine = setup({
  types: {
    input: {} as CallRequestInput,
    context: {} as CallRequestContext,
    events: {} as CallRequestEvent,
    output: {} as CallRequestOutput,
  },
  actors: {
    // Placeholders; the runtime provides the real ones, tests stubs.
    /** Finds the work the request names; rejects when there is no such work. */
    attach: fromPromise<null, CallRequestInput>(() => Promise.reject(new Error("attach not provided"))),
    /** Watches the work and sends `work.settled` once it finished or failed. */
    watch: fromCallback<CallRequestEvent, CallRequestInput>(() => () => undefined),
  },
  actions: {
    /** Shows the pending request in the thread. */
    announce: () => undefined,
    /** Rings Isaac's phone ("<assistant> is calling"). */
    ring: () => undefined,
    /** Isaac picked up: the thread card says so. */
    markConnected: () => undefined,
    /** No answer: one missed-call notification and the result in the thread. */
    notifyMissed: () => undefined,
    /** Isaac (or the assistant for him) called it off; a ringing phone stops ringing. */
    markCancelled: () => undefined,
    /** The work never settled within `maxWaitMs`. */
    markExpired: () => undefined,
    recordOutcome: assign({ outcome: (_, params: { outcome: WorkOutcome }) => params.outcome }),
    recordReason: assign({ reason: (_, params: { reason: string }) => params.reason }),
  },
  delays: {
    ringTimeout: ({ context }) => context.timing.ringMs,
    maxWait: ({ context }) => context.timing.maxWaitMs,
  },
}).createMachine({
  id: "callRequest",
  context: ({ input }) => ({ ...input, outcome: null, reason: null }),
  initial: "requested",
  output: ({ context }) => ({ outcome: context.outcome, reason: context.reason }),
  states: {
    requested: {
      invoke: {
        src: "attach",
        input: ({ context }) => context,
        onDone: "waiting",
        onError: {
          target: "rejected",
          actions: { type: "recordReason", params: ({ event }) => ({ reason: event.error instanceof Error ? event.error.message : String(event.error) }) },
        },
      },
      on: {
        "request.cancel": {
          target: "cancelled",
          actions: { type: "recordReason", params: ({ event }) => ({ reason: event.reason ?? "cancelled" }) },
        },
      },
    },
    waiting: {
      entry: "announce",
      invoke: { src: "watch", input: ({ context }) => context },
      after: {
        maxWait: { target: "expired", actions: { type: "recordReason", params: { reason: "the work never finished" } } },
      },
      on: {
        "work.settled": {
          target: "ringing",
          actions: { type: "recordOutcome", params: ({ event }) => ({ outcome: event.outcome }) },
        },
        "request.cancel": {
          target: "cancelled",
          actions: { type: "recordReason", params: ({ event }) => ({ reason: event.reason ?? "cancelled" }) },
        },
      },
    },
    ringing: {
      entry: "ring",
      after: { ringTimeout: "missed" },
      on: {
        "call.answered": "connected",
        "request.cancel": {
          target: "cancelled",
          actions: { type: "recordReason", params: ({ event }) => ({ reason: event.reason ?? "cancelled" }) },
        },
      },
    },
    connected: { type: "final", entry: "markConnected" },
    missed: { type: "final", entry: "notifyMissed" },
    cancelled: { type: "final", entry: "markCancelled" },
    expired: { type: "final", entry: "markExpired" },
    rejected: { type: "final" },
  },
});
