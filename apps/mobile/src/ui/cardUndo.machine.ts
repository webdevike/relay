/**
 * The Undo toast after a status card is dismissed (XState v5). A dismissal is applied at once; this
 * machine only decides how long the toast offering to take it back stays (`UNDO_MS`) and what Undo
 * does: restore the entry that was just dismissed. A second dismissal while the toast shows
 * replaces it (the first can no longer be undone from the toast, the card stays closed); Undo or
 * the timer ends it.
 *
 * Effects: `restore` (the dismissal's entry goes back on the host or phone set) is supplied by
 * `cardUndo.ts`; it does nothing without one.
 */
import { assign, setup } from "xstate";

/** How long the toast offers Undo (ms). */
export const UNDO_MS = 4000;

export interface CardUndoContext {
  /** The entry (`lib/dismissedCards.ts` `dismissKey`) the toast would bring back. */
  key: string;
  /** What the toast says: `Dismissed <card line>`, cut short by the caller. */
  message: string;
}

export type CardUndoEvent = { type: "card.dismissed"; key: string; message: string } | { type: "card.undo" };

export const cardUndoMachine = setup({
  types: { context: {} as CardUndoContext, events: {} as CardUndoEvent },
  actions: {
    // Supplied by `cardUndo.ts`.
    restore: () => undefined,
    remember: assign(({ event }) => (event.type === "card.dismissed" ? { key: event.key, message: event.message } : {})),
  },
  delays: { UNDO: UNDO_MS },
}).createMachine({
  id: "cardUndo",
  context: { key: "", message: "" },
  initial: "idle",
  states: {
    idle: {},
    offering: {
      after: { UNDO: { target: "idle" } },
      on: {
        "card.undo": { target: "idle", actions: "restore" },
      },
    },
  },
  on: {
    // Re-enters `offering` even from `offering`, so the timer starts over for the newest dismissal.
    "card.dismissed": { target: ".offering", reenter: true, actions: "remember" },
  },
});
