/**
 * Routes live-view frames into the screen store. Frames for a window other than the one asked for
 * (a late frame from the previous watch) are dropped.
 */
import type { ServerMessage } from "@relay/protocol";
import type { ScreenStore } from "@/state/screen";

export type ScreenStoreActions = Pick<ScreenStore, "setList" | "setFrame" | "setEnded">;

export type ScreenFrameRouter = (message: ServerMessage) => void;

export function createScreenFrameRouter(store: ScreenStoreActions, watching: () => number | null): ScreenFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "screen.list") {
      store.setList(message.windows, message.error ?? null);
    } else if (message.t === "screen.frame") {
      if (message.windowId !== watching()) return;
      store.setFrame({
        windowId: message.windowId,
        uri: `data:image/jpeg;base64,${message.jpeg}`,
        width: message.width,
        height: message.height,
      });
    } else if (message.t === "screen.ended" && message.windowId === watching()) {
      store.setEnded(message.error);
    }
  };
}
