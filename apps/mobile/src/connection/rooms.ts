/**
 * Routes Rooms' server frames: `welcome` says whether the host relays rooms (`features` has
 * ROOMS_FEATURE; an older host drops the socket on a frame it does not know, so nothing is sent
 * without it), pause / resume (ROOMS_RESUME_FEATURE), chat rooms (ROOMS_CHAT_FEATURE) and actions
 * on their decision cards (ROOMS_DECIDE_FEATURE),
 * `rooms.state` replaces the list, `rooms.room` patches one, and `rooms.res` settles the
 * `rooms.cmd` waiting on its rid.
 */
import { createActor, waitFor } from "xstate";
import { ROOMS_CHAT_FEATURE, ROOMS_DECIDE_FEATURE, ROOMS_FEATURE, ROOMS_RESUME_FEATURE, type RoomsResult, type ServerMessage } from "@relay/protocol";
import { ROOMS_TIMEOUT_MS, roomsRequestMachine, type RoomsRequest } from "@/rooms/roomsRequest.machine";
import type { RoomsStore } from "@/state/rooms";

export type RoomsFrameRouter = (message: ServerMessage) => void;

/**
 * `rooms.cmd` requests the desktop has not settled, by rid: pending ones and unconfirmed ones (a late
 * `rooms.res` still settles those). Each is a `roomsRequestMachine` actor; it leaves once answered or failed.
 */
export class PendingRooms {
  private readonly open = new Map<string, RoomsRequest>();

  constructor(private readonly timeoutMs = ROOMS_TIMEOUT_MS) {}

  /** Sends `rid` through `transmit` now, and again with the same rid on every Try again. */
  start(rid: string, transmit: () => void, view: string | null = null): RoomsRequest {
    const request = createActor(roomsRequestMachine.provide({ actions: { transmit }, delays: { answerTimeout: this.timeoutMs } }), {
      input: { rid, view },
    });
    request.subscribe((snapshot) => {
      if (snapshot.matches("answered") || snapshot.matches("failed")) this.open.delete(rid);
    });
    this.open.set(rid, request);
    request.start();
    return request;
  }

  settle(rid: string, result: RoomsResult): void {
    this.open.get(rid)?.send({ type: "request.answered", result });
  }

  /** The socket closed or the connection went to another host: nothing still open will be answered. */
  cancelAll(message = "Disconnected."): void {
    for (const request of [...this.open.values()]) request.send({ type: "request.cancelled", result: { ok: false, code: "disconnected", message } });
  }
}

/** A request refused before it was sent (offline, a host without Rooms): it starts failed. */
export function refusedRequest(result: RoomsResult): RoomsRequest {
  return createActor(roomsRequestMachine, { input: { rid: "", refused: result } }).start();
}

/** The first outcome of a request that only wants a value (an image): unconfirmed reads as a timeout. */
export async function requestOutcome(request: RoomsRequest): Promise<RoomsResult> {
  const snapshot = await waitFor(request, (s) => !s.matches("sending") && !s.matches("pending"));
  return snapshot.matches("unconfirmed") || snapshot.context.result === null
    ? { ok: false, code: "timeout", message: "Your Mac did not answer." }
    : snapshot.context.result;
}

type RoutedStore = Pick<RoomsStore, "setSupported" | "setState" | "upsert">;

export function createRoomsFrameRouter(store: RoutedStore, pending: PendingRooms): RoomsFrameRouter {
  // Every other frame belongs to the session machine, the command queue or another router.
  return (message) => {
    if (message.t === "welcome")
      store.setSupported(
        message.features?.includes(ROOMS_FEATURE) === true,
        message.features?.includes(ROOMS_RESUME_FEATURE) === true,
        message.features?.includes(ROOMS_CHAT_FEATURE) === true,
        message.features?.includes(ROOMS_DECIDE_FEATURE) === true,
      );
    if (message.t === "rooms.state") store.setState(message.rooms);
    if (message.t === "rooms.room") store.upsert(message.room);
    if (message.t === "rooms.res") pending.settle(message.rid, message.result);
  };
}
