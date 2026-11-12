/**
 * One sent assistant turn's echo bubble (XState v5), from the tap until its row lands in the
 * thread. `sending` until the host acks (receipt "Sending"), then `sent` ("Sent"). A refusal
 * (`nack`, or never sent) is `refused`: the bubble goes and the composer gets its words and photos
 * back. A timeout is `unconfirmed`, not a failure: the host may have delivered it (an assistant
 * whose omp was asleep acks late), so the bubble stays, reads "Not confirmed" and offers Try again,
 * which sends the same turn with the same `clientId` (the host lands a `clientId` once), never the
 * draft. A late ack then makes it `sent`.
 *
 * The echo leaves when the thread lists the turn as a row (`landed`: `state/assistant.ts`
 * `settlePending` decides that from the snapshot), when Isaac dismisses a stuck unconfirmed one,
 * or, once sent, after `ACKED_ECHO_MS` of an idle thread (a slash command, or a turn omp drops,
 * leaves no row of his).
 *
 * Pure: the runtime (`state/turns.ts`) supplies `deliver` (the first attempt's delivery, then a
 * resend), `threadIdle` and `reportRefusal`, and projects the state into the store.
 */
import { assign, fromPromise, setup, type SnapshotFrom } from "xstate";

/** An acked turn that leaves no row of Isaac's goes this long after the ack once the thread is idle. */
export const ACKED_ECHO_MS = 30_000;

export interface TurnInput {
  agent: string;
  clientId: string;
  /** Whether the turn can be sent again as itself (it carries a `clientId` the host dedups by). */
  canRetry: boolean;
}

export interface TurnContext extends TurnInput {
  /** 0 for the tap's own delivery, then one more per Try again. */
  attempt: number;
}

export type TurnEvent =
  /** Try again on an unconfirmed echo: the same turn, the same `clientId`. */
  | { type: "turn.retry" }
  /** Isaac took a stuck unconfirmed echo away. */
  | { type: "turn.dismiss" }
  /** The thread lists the turn as a row of Isaac's. */
  | { type: "turn.landed" }
  /** The ack of a turn that had timed out came after all. */
  | { type: "command.lateAck" }
  | { type: "command.lateNack"; error: unknown };

function notProvided(name: string): never {
  throw new Error(`turn machine "${name}" not provided`);
}

export const turnMachine = setup({
  types: {
    context: {} as TurnContext,
    events: {} as TurnEvent,
    input: {} as TurnInput,
  },
  actors: {
    deliver: fromPromise<null, { attempt: number }>(() => notProvided("deliver")),
  },
  actions: {
    reportRefusal: (_, params: { error: unknown }) => {
      notProvided(`reportRefusal (${String(params.error)})`);
    },
    nextAttempt: assign({ attempt: ({ context }) => context.attempt + 1 }),
  },
  guards: {
    // The command queue's `CommandError` with code "timeout": the outcome is unknown, not a refusal.
    timedOut: ({ event }) => "error" in event && typeof event.error === "object" && event.error !== null && "code" in event.error && event.error.code === "timeout",
    canRetry: ({ context }) => context.canRetry,
    threadIdle: () => true,
  },
  delays: {
    ACKED_ECHO: ACKED_ECHO_MS,
  },
}).createMachine({
  id: "turn",
  context: ({ input }) => ({ ...input, attempt: 0 }),
  initial: "sending",
  on: {
    "turn.landed": { target: ".settled" },
  },
  states: {
    sending: {
      invoke: {
        src: "deliver",
        input: ({ context }) => ({ attempt: context.attempt }),
        onDone: { target: "sent" },
        onError: [
          { guard: "timedOut", target: "unconfirmed" },
          { target: "refused", actions: { type: "reportRefusal", params: ({ event }) => ({ error: event.error }) } },
        ],
      },
    },
    sent: {
      after: { ACKED_ECHO: { guard: "threadIdle", target: "settled" } },
    },
    unconfirmed: {
      on: {
        "turn.retry": { guard: "canRetry", target: "sending", actions: "nextAttempt" },
        "command.lateAck": { target: "sent" },
        "command.lateNack": { target: "refused", actions: { type: "reportRefusal", params: ({ event }) => ({ error: event.error }) } },
        "turn.dismiss": { target: "dismissed" },
      },
    },
    refused: { type: "final" },
    settled: { type: "final" },
    dismissed: { type: "final" },
  },
});

export type TurnSnapshot = SnapshotFrom<typeof turnMachine>;
