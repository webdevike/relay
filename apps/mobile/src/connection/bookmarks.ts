/**
 * Routes the host's bookmark frames into the bookmarks store: `welcome` says whether it keeps them
 * (`welcome.features`), and `bookmarks.snapshot` (the answer to `bookmarks.get`, pushed to every
 * device on each change) replaces a thread's set. The phone's own bookmarks of a thread go up once,
 * with its first snapshot.
 */
import { BOOKMARKS_FEATURE, type ServerMessage } from "@relay/protocol";
import type { BookmarksStore } from "@/state/bookmarks";

export type BookmarkFrameRouter = (message: ServerMessage) => void;

export function createBookmarkFrameRouter(
  store: Pick<BookmarksStore, "setHost" | "setHostUp">,
  /** Sends `bookmark.set` for a turn the phone had and the host did not. */
  sendUp: (thread: string, key: string) => void,
): BookmarkFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "welcome")
      store.setHostUp(message.features?.includes(BOOKMARKS_FEATURE) === true);
    if (message.t === "bookmarks.snapshot") {
      for (const key of store.setHost(message.thread, message.messages))
        sendUp(message.thread, key);
    }
  };
}
