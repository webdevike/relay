/**
 * Where hold-to-talk sends its words, as an owner stack (XState v5). Pure: no React, no network.
 *
 * Every screen that points dictation somewhere pushes its own entry and releases only that entry
 * when it leaves, so the order of one screen's focus and the previous screen's blur no longer
 * matters (the next screen's focus can land first). The top entry is the target; with none left,
 * the words are typed into the Mac's focused app (`INSERT`).
 *
 *   insert  nobody owns dictation
 *   owned   at least one entry; a release of the last owner goes back to insert
 *
 * Releasing an entry twice, or one that was never pushed, changes nothing.
 */
import { assign, setup, type SnapshotFrom } from "xstate";

export type DictationTarget =
  | { kind: "insert" }
  /**
   * `pendingAskId`: the ask the session is blocked on. A reply sent behind it would only queue until
   * the ask closes (and omp drops an ask with messages queued), so the ask is cancelled first.
   */
  | { kind: "agent"; sessionId: string; pendingAskId?: string }
  /**
   * An assistant's thread: the words are Isaac's next `assistant.turn`. `onTurn` hears of the turn
   * the moment it is sent (before the command leaves), with the delivery and the turn's `clientId`
   * (a resend with the same id is delivered once), so the thread can show the echo at once and mark
   * a refusal.
   */
  | {
      kind: "assistant";
      agent: string;
      onTurn?: (text: string, delivery: Promise<void>, clientId: string) => void;
    }
  /** A screen of the phone's own (a meeting's Ask): the words go to `onText` and no command is sent. */
  | { kind: "local"; onText: (text: string) => Promise<void> };

export const INSERT: DictationTarget = { kind: "insert" };

/** One screen's claim on dictation: `owner` is unique per push. */
export interface TargetEntry {
  owner: number;
  target: DictationTarget;
}

export interface TargetStackContext {
  /** Oldest first; the last entry is the target. */
  entries: TargetEntry[];
}

export type TargetStackEvent =
  | { type: "target.pushed"; owner: number; target: DictationTarget }
  | { type: "target.released"; owner: number };

export const targetStackMachine = setup({
  types: {
    context: {} as TargetStackContext,
    events: {} as TargetStackEvent,
  },
  actions: {
    addEntry: assign({
      entries: ({ context, event }) =>
        event.type === "target.pushed"
          ? [...context.entries, { owner: event.owner, target: event.target }]
          : context.entries,
    }),
    dropEntry: assign({
      entries: ({ context, event }) => context.entries.filter((entry) => entry.owner !== event.owner),
    }),
  },
  guards: {
    lastOwner: ({ context, event }) =>
      context.entries.length === 1 && context.entries[0]?.owner === event.owner,
  },
}).createMachine({
  id: "dictationTargets",
  context: { entries: [] },
  initial: "insert",
  states: {
    insert: {
      on: { "target.pushed": { target: "owned", actions: "addEntry" } },
    },
    owned: {
      on: {
        "target.pushed": { actions: "addEntry" },
        "target.released": [
          { guard: "lastOwner", target: "insert", actions: "dropEntry" },
          { actions: "dropEntry" },
        ],
      },
    },
  },
});

export type TargetStackSnapshot = SnapshotFrom<typeof targetStackMachine>;

/** The top entry's target, or `INSERT` when nobody owns dictation. */
export function targetOf(snapshot: TargetStackSnapshot): DictationTarget {
  return snapshot.context.entries.at(-1)?.target ?? INSERT;
}
