/**
 * The app-wide Undo toast of dismissed status cards: one `cardUndoMachine` actor, so the toast
 * outlives the card that closed (a dismissed card unmounts). `dismissCard` closes a card and offers
 * Undo; `CardUndoToast` draws the offer.
 */
import { createActor } from "xstate";
import { setCardDismissed } from "@/connection";
import { dismissKey } from "@/lib/dismissedCards";
import { cardUndoMachine } from "./cardUndo.machine";

/** The longest a card's line goes into the toast's words. */
const LINE_MAX = 40;

export const cardUndoActor = createActor(
  cardUndoMachine.provide({
    actions: {
      restore: ({ context }) => {
        setCardDismissed(context.key, false);
      },
    },
  }),
).start();

/** Hides card `id` (a running card only while it runs) and offers Undo for a few seconds. */
export function dismissCard(id: string, running: boolean, line: string): void {
  const key = dismissKey(id, running);
  setCardDismissed(key, true);
  const short = line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
  cardUndoActor.send({ type: "card.dismissed", key, message: short === "" ? "Card dismissed" : `Dismissed: ${short}` });
}
