/**
 * Isaac's answer to one ask (XState v5): a session's ask card (`agent.ask`, keyed by its session and
 * ask id) and the thread's open ask that stands for the same question (`OpenAsk` with that
 * `sessionId`/`askId`) are one record, so answering it from the card, a chip or the open-questions
 * sheet sends once. An answer is allowed only while `open` or `failed`: a second tap while
 * `answering` is refused. A timeout or a refusal is `failed` with its reason; the card and the row
 * show again, and answering again (or `ask.retry`) sends the same unit: the same turn `clientId`
 * and the same closing command. The host dropping the ask ends the record (`gone`) from any state.
 *
 * Pure: the runtime (`agents/asks.ts`) supplies `deliver` (sends the reply's commands and starts or
 * retries its turn) and keeps each record's state in `useAgentsStore().askRecords`.
 */
import { assign, fromPromise, setup, type SnapshotFrom } from "xstate";
import type { Command } from "@relay/protocol";

/** What one answer sends, as a unit: kept so a retry sends exactly the same again. */
export interface AskReply {
  /** Isaac's turn that carries the answer (a reply chip's words), shown as his echo; null for a card or a session ask. */
  turn: { agent: string; clientId: string; text: string } | null;
  /** The commands that close the ask on the host: `agent.ask.answer`/`agent.ask.cancel` and/or `assistant.ask.resolve`. */
  commands: Command[];
}

export interface AskContext {
  /** The last answer or dismissal sent; a retry sends it again. */
  reply: AskReply | null;
  /** Why the last send failed, for the card; null otherwise. */
  failure: string | null;
  /** 0 for the first send, then one more per retry. */
  attempt: number;
}

export type AskEvent =
  | { type: "ask.answer"; reply: AskReply }
  | { type: "ask.dismiss"; reply: AskReply }
  /** Send the failed answer or dismissal again, unchanged. */
  | { type: "ask.retry" }
  /** The host no longer lists the ask (answered here or elsewhere, or withdrawn). */
  | { type: "host.dropped" };

function notProvided(name: string): never {
  throw new Error(`ask machine "${name}" not provided`);
}

export const askMachine = setup({
  types: {
    context: {} as AskContext,
    events: {} as AskEvent,
  },
  actors: {
    deliver: fromPromise<null, { reply: AskReply; attempt: number }>(() => notProvided("deliver")),
  },
  actions: {
    keepReply: assign({ reply: ({ event }) => ("reply" in event ? event.reply : null), failure: null }),
    nextAttempt: assign({ attempt: ({ context }) => context.attempt + 1, failure: null }),
    keepFailure: assign((_, params: { error: unknown }) => ({
      failure: params.error instanceof Error && params.error.message !== "" ? params.error.message : "Not sent.",
    })),
  },
  guards: {
    wasDismissing: ({ context }) => context.reply?.commands.some((command) => command.kind === "agent.ask.cancel" || (command.kind === "assistant.ask.resolve" && command.how === "dismissed")) === true,
  },
}).createMachine({
  id: "ask",
  context: { reply: null, failure: null, attempt: 0 },
  initial: "open",
  on: {
    "host.dropped": { target: ".gone" },
  },
  states: {
    open: {
      on: {
        "ask.answer": { target: "answering", actions: "keepReply" },
        "ask.dismiss": { target: "dismissing", actions: "keepReply" },
      },
    },
    answering: {
      invoke: {
        src: "deliver",
        input: ({ context }) => ({ reply: context.reply ?? { turn: null, commands: [] }, attempt: context.attempt }),
        onDone: { target: "answered" },
        onError: { target: "failed", actions: { type: "keepFailure", params: ({ event }) => ({ error: event.error }) } },
      },
    },
    dismissing: {
      invoke: {
        src: "deliver",
        input: ({ context }) => ({ reply: context.reply ?? { turn: null, commands: [] }, attempt: context.attempt }),
        onDone: { target: "dismissed" },
        onError: { target: "failed", actions: { type: "keepFailure", params: ({ event }) => ({ error: event.error }) } },
      },
    },
    /** The answer reached the host; hidden until the host drops the ask. */
    answered: {},
    dismissed: {},
    failed: {
      on: {
        "ask.answer": { target: "answering", actions: ["keepReply", "nextAttempt"] },
        "ask.dismiss": { target: "dismissing", actions: ["keepReply", "nextAttempt"] },
        "ask.retry": [
          { guard: "wasDismissing", target: "dismissing", actions: "nextAttempt" },
          { target: "answering", actions: "nextAttempt" },
        ],
      },
    },
    gone: { type: "final" },
  },
});

export type AskSnapshot = SnapshotFrom<typeof askMachine>;
/** Every state a record shows as (`gone` has no record). */
export type AskRecordState = Exclude<AskSnapshot["value"], "gone">;
