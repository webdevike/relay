/**
 * Routes `catchup.snapshot` into the Catch Up store (the host answers `catchup.list` with it and pushes
 * it on every change) and `catchup.noted`, the host's answer to a note, into `noteAnswer`.
 */
import type { ServerMessage } from "@relay/protocol";
import type { CatchUpStore } from "@/state/catchup";

export type CatchUpFrameRouter = (message: ServerMessage) => void;

export function createCatchUpFrameRouter(store: Pick<CatchUpStore, "set" | "noted">): CatchUpFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "catchup.snapshot") store.set({ items: message.items, unreadCount: message.unreadCount });
    else if (message.t === "catchup.noted") store.noted(message.id, message.ok);
  };
}
