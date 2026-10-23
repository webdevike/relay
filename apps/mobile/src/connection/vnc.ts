/**
 * Routes the host's answers to `vnc.open` into the VNC store: a ticket becomes the bridge URL on
 * the host the socket is connected to, `vnc.unavailable` means Screen Sharing is off.
 */
import type { ServerMessage } from "@relay/protocol";
import type { VncStore } from "@/state/vnc";
import { vncUrl } from "@/vnc/messages";

export type VncFrameRouter = (message: ServerMessage) => void;

export function createVncFrameRouter(store: Pick<VncStore, "setAccess">, authority: () => string | null): VncFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "vnc.ticket") {
      const host = authority();
      store.setAccess(host === null ? { kind: "idle" } : { kind: "ready", url: vncUrl(host, message.ticket) });
    } else if (message.t === "vnc.unavailable") {
      store.setAccess({ kind: "off" });
    }
  };
}
