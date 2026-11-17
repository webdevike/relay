import { assign, fromCallback, fromPromise, setup } from "xstate";

/**
 * One Soundly session, start to end, around the work done with Soundly's cloud API. Soundly allows one signed-in
 * session per account, so the API sign-in inside `work` signs the desktop app out. The machine makes sure the app is
 * left as it was found:
 * - It waits while Isaac is using Soundly (it is the app in front and he gave input lately), up to `maxWaits` reads.
 * - An open Soundly is quit before the sign-in (so a quit that fails touches nothing), and relaunched hidden after
 *   it, whatever the work did; the relaunch signs it in again from its saved login, and the session ends only once the
 *   app is seen signed in (or fails saying it is not).
 * - A closed Soundly stays closed.
 * Pure: the runtime (`../soundly.ts`) provides the actors, tests provide stubs.
 */

export type FailureKind =
  /** Isaac kept using Soundly for the whole wait. The app was not touched. */
  | "busy"
  /** Soundly could not be read or quit. The app was not touched. */
  | "unavailable"
  /** The work itself crashed (its own failures come back in `work.value`). */
  | "work_failed"
  /** Soundly could not be relaunched after the work: it is closed and signed out. */
  | "relaunch_failed"
  /** Soundly relaunched but was not seen signed in within the wait. */
  | "not_signed_in"
  /** Cancelled while waiting for Isaac; nothing was touched. */
  | "cancelled";

export class SessionFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
  }
}

/** One look at the desktop app. */
export interface Probe {
  readonly running: boolean;
  /** Why Isaac counts as using Soundly right now, else undefined. */
  readonly inUse: string | undefined;
}

export interface SessionOutput {
  /** Soundly was open when the session started (so it was quit and relaunched). */
  readonly wasOpen: boolean;
  /** What `work` resolved with; absent when the session never got to sign in. */
  readonly work?: { readonly value: unknown };
  /** How the relaunched app was seen signed in again (only when it was open). */
  readonly verifiedBy?: ReadonlyArray<string>;
  readonly failure?: { readonly kind: FailureKind; readonly message: string };
}

type SignedIn = { type: "app.signedIn"; verifiedBy: ReadonlyArray<string> };
type Cancel = { type: "session.cancel" };

const failureOf = (error: unknown, kind: FailureKind) =>
  error instanceof SessionFailure
    ? { kind: error.kind, message: error.message }
    : { kind, message: error instanceof Error ? error.message : String(error) };

export const sessionMachine = setup({
  types: {
    input: {} as { readonly maxWaits: number },
    context: {} as {
      readonly maxWaits: number;
      readonly waits: number;
      readonly wasOpen: boolean;
      readonly work: { readonly value: unknown } | undefined;
      readonly verifiedBy: ReadonlyArray<string> | undefined;
      readonly failure: { readonly kind: FailureKind; readonly message: string } | undefined;
    },
    events: {} as SignedIn | Cancel,
    output: {} as SessionOutput,
  },
  actors: {
    probe: fromPromise<Probe>(async () => {
      throw new Error("probe not provided");
    }),
    quit: fromPromise<void>(async () => {
      throw new Error("quit not provided");
    }),
    work: fromPromise<unknown>(async () => {
      throw new Error("work not provided");
    }),
    relaunch: fromPromise<void>(async () => {
      throw new Error("relaunch not provided");
    }),
    watch: fromCallback<SignedIn>(() => {
      throw new Error("watch not provided");
    }),
  },
  guards: {
    isInUse: (_, params: { probe: Probe }) => params.probe.inUse !== undefined,
    /** In use, and the wait has reads left. */
    mayWait: ({ context }, params: { probe: Probe }) =>
      params.probe.inUse !== undefined && context.waits < context.maxWaits,
    isOpen: (_, params: { probe: Probe }) => params.probe.running,
    wasOpen: ({ context }) => context.wasOpen,
  },
  delays: {
    /** Between looks while Isaac is using Soundly. */
    poll: 15_000,
    /** From the relaunch to the app seen signed in. */
    signInTimeout: 120_000,
  },
  actions: {
    recordFailure: assign({
      failure: (_, params: { error: unknown; kind: FailureKind }) =>
        failureOf(params.error, params.kind),
    }),
  },
}).createMachine({
  id: "soundlySession",
  initial: "gating",
  context: ({ input }) => ({
    maxWaits: input.maxWaits,
    waits: 0,
    wasOpen: false,
    work: undefined,
    verifiedBy: undefined,
    failure: undefined,
  }),
  states: {
    gating: {
      initial: "checking",
      on: {
        "session.cancel": {
          target: "cancelled",
          actions: assign({
            failure: {
              kind: "cancelled",
              message: "cancelled while waiting for Isaac to leave Soundly",
            },
          }),
        },
      },
      states: {
        checking: {
          invoke: {
            src: "probe",
            onDone: [
              {
                guard: { type: "mayWait", params: ({ event }) => ({ probe: event.output }) },
                target: "waiting",
              },
              {
                guard: { type: "isInUse", params: ({ event }) => ({ probe: event.output }) },
                target: "#soundlySession.failed",
                actions: assign({
                  failure: ({ event }) => ({
                    kind: "busy" as const,
                    message: `Isaac is using Soundly (${event.output.inUse ?? ""}); left it alone`,
                  }),
                }),
              },
              {
                guard: { type: "isOpen", params: ({ event }) => ({ probe: event.output }) },
                target: "#soundlySession.quitting",
                actions: assign({ wasOpen: true }),
              },
              { target: "#soundlySession.working" },
            ],
            onError: {
              target: "#soundlySession.failed",
              actions: {
                type: "recordFailure",
                params: ({ event }) => ({ error: event.error, kind: "unavailable" }),
              },
            },
          },
        },
        waiting: {
          after: {
            poll: {
              target: "checking",
              actions: assign({ waits: ({ context }) => context.waits + 1 }),
            },
          },
        },
      },
    },
    quitting: {
      invoke: {
        src: "quit",
        onDone: "working",
        onError: {
          target: "failed",
          actions: {
            type: "recordFailure",
            params: ({ event }) => ({ error: event.error, kind: "unavailable" }),
          },
        },
      },
    },
    working: {
      invoke: {
        src: "work",
        onDone: [
          {
            guard: "wasOpen",
            target: "restoring",
            actions: assign({ work: ({ event }) => ({ value: event.output }) }),
          },
          { target: "done", actions: assign({ work: ({ event }) => ({ value: event.output }) }) },
        ],
        // The sign-in may have happened: an open app is relaunched all the same.
        onError: [
          {
            guard: "wasOpen",
            target: "restoring",
            actions: {
              type: "recordFailure",
              params: ({ event }) => ({ error: event.error, kind: "work_failed" }),
            },
          },
          {
            target: "failed",
            actions: {
              type: "recordFailure",
              params: ({ event }) => ({ error: event.error, kind: "work_failed" }),
            },
          },
        ],
      },
    },
    restoring: {
      initial: "relaunching",
      after: {
        signInTimeout: {
          target: "failed",
          actions: assign({
            failure: {
              kind: "not_signed_in",
              message: "Soundly relaunched but was not seen signed in within 2 minutes",
            },
          }),
        },
      },
      states: {
        relaunching: {
          invoke: {
            src: "relaunch",
            onDone: "watching",
            onError: {
              target: "#soundlySession.failed",
              actions: {
                type: "recordFailure",
                params: ({ event }) => ({ error: event.error, kind: "relaunch_failed" }),
              },
            },
          },
        },
        watching: {
          invoke: { src: "watch" },
          on: {
            "app.signedIn": {
              target: "#soundlySession.done",
              actions: assign({ verifiedBy: ({ event }) => event.verifiedBy }),
            },
          },
        },
      },
    },
    done: { type: "final" },
    failed: { type: "final" },
    cancelled: { type: "final" },
  },
  output: ({ context }) => ({
    wasOpen: context.wasOpen,
    ...(context.work === undefined ? {} : { work: context.work }),
    ...(context.verifiedBy === undefined ? {} : { verifiedBy: context.verifiedBy }),
    ...(context.failure === undefined ? {} : { failure: context.failure }),
  }),
});
