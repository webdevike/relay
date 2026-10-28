/**
 * Routes the host's canvas frames into the canvas store: `canvas.rooms` replaces the room list,
 * `canvas.access` becomes the web client's URL on the host the socket is connected to, and
 * `canvas.unavailable` says the board's session ended.
 */
import type { ClientMessage, ServerMessage } from "@relay/protocol";
import { usableAccess, type CanvasAccessState, type CanvasStore } from "@/state/canvas";

export type CanvasFrameRouter = (message: ServerMessage) => void;

export function createCanvasFrameRouter(store: Pick<CanvasStore, "setRooms" | "setAccess">, authority: () => string | null): CanvasFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "canvas.rooms") {
      store.setRooms(message.rev, message.rooms);
    } else if (message.t === "canvas.access") {
      const host = authority();
      // The socket went away before the answer: the next welcome's open asks again.
      if (host === null) return;
      const path = message.path.startsWith("/") ? message.path : `/${message.path}`;
      store.setAccess(message.slug, { kind: "ready", url: `http://${host}${path}`, expiresAt: message.expiresAt });
    } else if (message.t === "canvas.unavailable") {
      store.setAccess(message.slug, { kind: "unavailable", reason: message.reason });
    }
  };
}

/**
 * Join's way into the room on `slug`: a token still good for a while is reused (stepping back in
 * never reloads the room); otherwise the slug waits as `asking` and `canvas.open` goes out now
 * when connected, or from `pendingCanvasOpens` on the next welcome.
 */
export function beginCanvasAccess(
  store: Pick<CanvasStore, "access" | "setAccess">,
  slug: string,
  { now, connected, send }: { now: number; connected: boolean; send: (message: ClientMessage) => void },
): void {
  if (usableAccess(store.access[slug], now)) return;
  store.setAccess(slug, { kind: "asking" });
  if (connected) send({ t: "canvas.open", slug });
}

/** What a fresh connection sends for canvases: the room list, and every open still unanswered. */
export function canvasWelcomeFrames(access: Record<string, CanvasAccessState>): ClientMessage[] {
  const opens = Object.entries(access).flatMap(([slug, entry]): ClientMessage[] => (entry.kind === "asking" ? [{ t: "canvas.open", slug }] : []));
  return [{ t: "canvas.get" }, ...opens];
}