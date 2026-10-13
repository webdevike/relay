/** Routes `board.snapshot` / `board.delta` into the boards store. */
import type { ServerMessage } from "@relay/protocol";
import type { BoardsStore } from "@/state/boards";

export type BoardFrameRouter = (message: ServerMessage) => void;

export function createBoardFrameRouter(store: Pick<BoardsStore, "setAll" | "upsert" | "remove">): BoardFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "board.snapshot") {
      store.setAll(message.boards);
    } else if (message.t === "board.delta") {
      if (message.board !== undefined) store.upsert(message.board);
      if (message.removed !== undefined) store.remove(message.removed);
    }
  };
}
