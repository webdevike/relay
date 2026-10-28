/**
 * Routes `reactions.snapshot` into the reactions store: the host's answer to `reactions.get`, and
 * its push to every device whenever a thread's reactions change (this phone's own included).
 */
import type { ServerMessage } from "@relay/protocol";
import type { ReactionsStore } from "@/state/reactions";

export type ReactionFrameRouter = (message: ServerMessage) => void;

export function createReactionFrameRouter(store: Pick<ReactionsStore, "set">): ReactionFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "reactions.snapshot") store.set(message.thread, message.reactions);
  };
}
