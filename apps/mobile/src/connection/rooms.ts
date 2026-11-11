/**
 * Routes Rooms' server frames: `welcome` says whether the host relays rooms (`features` has
 * ROOMS_FEATURE; an older host drops the socket on a frame it does not know, so nothing is sent
 * without it) and pause / resume (ROOMS_RESUME_FEATURE), `rooms.state` replaces the list,
 * `rooms.room` patches one, and `rooms.res` settles the `rooms.cmd` waiting on its rid.
 */
import { ROOMS_FEATURE, ROOMS_RESUME_FEATURE, type RoomsResult, type ServerMessage } from "@relay/protocol";
import type { RoomsStore } from "@/state/rooms";

export type RoomsFrameRouter = (message: ServerMessage) => void;

/** How long a room command waits for the desktop's answer before it counts as failed. */
export const ROOMS_TIMEOUT_MS = 30_000;

/** `rooms.cmd` commands sent and not yet answered, by rid. */
export class PendingRooms {
  private readonly waiting = new Map<string, { resolve: (result: RoomsResult) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly timeoutMs = ROOMS_TIMEOUT_MS) {}

  /** Resolves with the answer to `rid`, or a failure after the timeout or `cancelAll`. */
  add(rid: string): Promise<RoomsResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(rid, { ok: false, code: "timeout", message: "Your Mac did not answer." });
      }, this.timeoutMs);
      this.waiting.set(rid, { resolve, timer });
    });
  }

  settle(rid: string, result: RoomsResult): void {
    const entry = this.waiting.get(rid);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.waiting.delete(rid);
    entry.resolve(result);
  }

  /** The connection went to another host: nothing still waiting will be answered. */
  cancelAll(): void {
    for (const rid of [...this.waiting.keys()]) this.settle(rid, { ok: false, code: "disconnected", message: "Disconnected." });
  }
}

type RoutedStore = Pick<RoomsStore, "setSupported" | "setState" | "upsert">;

export function createRoomsFrameRouter(store: RoutedStore, pending: PendingRooms): RoomsFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "welcome")
      store.setSupported(message.features?.includes(ROOMS_FEATURE) === true, message.features?.includes(ROOMS_RESUME_FEATURE) === true);
    if (message.t === "rooms.state") store.setState(message.rooms);
    if (message.t === "rooms.room") store.upsert(message.room);
    if (message.t === "rooms.res") pending.settle(message.rid, message.result);
  };
}
