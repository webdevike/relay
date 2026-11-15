/**
 * Routes the host's reply widget frames into the reply widgets store: `welcome` says whether it
 * keeps follow-up widgets and takes 🎯 labels (`welcome.features`), `widgets.snapshot` (the answer
 * to `widgets.get`, pushed to every device when a block is added) replaces a thread's blocks, and
 * `widget.labeled` is the host's answer to a label.
 */
import type { ServerMessage } from "@relay/protocol";
import type { ReplyWidgetsStore } from "@/state/replyWidgets";

export type ReplyWidgetFrameRouter = (message: ServerMessage) => void;

export function createReplyWidgetFrameRouter(
  store: Pick<ReplyWidgetsStore, "setFeatures" | "set" | "labeled">,
): ReplyWidgetFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "welcome") store.setFeatures(message.features);
    else if (message.t === "widgets.snapshot") store.set(message.thread, message.widgets);
    else if (message.t === "widget.labeled")
      store.labeled({ thread: message.thread, message: message.message, ok: message.ok, error: message.error });
  };
}
