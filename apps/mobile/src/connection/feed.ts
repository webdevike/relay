/** Routes `feed.snapshot`, the host's answer to `feed.list`, into the Feed store. */
import type { ServerMessage } from "@relay/protocol";
import type { FeedStore } from "@/state/feed";

export type FeedFrameRouter = (message: ServerMessage) => void;

export function createFeedFrameRouter(store: Pick<FeedStore, "set">): FeedFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "feed.snapshot") store.set({ generatedAt: message.generatedAt, items: message.items, acted: message.acted });
  };
}
