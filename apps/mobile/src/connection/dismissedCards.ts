/**
 * Routes the host's dismissed-card frames into the store: `welcome` says whether it keeps them
 * (`welcome.features`), and `cards.dismissed` (the answer to `cards.get`, pushed to every device
 * on each change) replaces the set. What the phone dismissed while it did not know the host's set
 * goes up once, with the first frame.
 */
import { CARDS_DISMISSED_FEATURE, type ServerMessage } from "@relay/protocol";
import type { DismissedCardsStore } from "@/state/dismissedCards";

export type DismissedCardFrameRouter = (message: ServerMessage) => void;

export function createDismissedCardFrameRouter(
  store: Pick<DismissedCardsStore, "setHost" | "setHostUp">,
  /** Sends `card.dismiss` for a card the phone dismissed and the host did not know. */
  sendUp: (id: string) => void,
): DismissedCardFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "welcome") store.setHostUp(message.features?.includes(CARDS_DISMISSED_FEATURE) === true);
    if (message.t === "cards.dismissed") {
      for (const id of store.setHost(message.ids)) sendUp(id);
    }
  };
}
