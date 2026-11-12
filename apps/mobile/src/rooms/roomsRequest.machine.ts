/**
 * One Rooms command (`rooms.cmd`) from the tap to what Isaac sees (XState v5). Pure: no React, no
 * socket. The runtime supplies `transmit`, which sends the frame with this request's rid.
 *
 *   sending      a request refused before anything went out (offline, host without Rooms) fails here
 *   pending      sent; waits for the desktop's `rooms.res`
 *   unconfirmed  no answer in time, so the desktop may have done it. A late answer still settles it;
 *                Try again (`request.retry`) sends the same rid, which a current host answers only once
 *   answered     the desktop did it. `landing` until the room frame shows it (the caller's `view`
 *                of the thing the command changes moves), so the card stays busy and a second tap
 *                cannot post or answer twice
 *   failed       the desktop refused, or the connection ended before an answer
 *
 * The host's own `timeout` and `device-gone` answers say nothing about whether the desktop did it,
 * so they count as unconfirmed, not failed.
 */
import { assign, setup, type ActorRefFrom, type SnapshotFrom } from "xstate";
import type { RoomsResult } from "@relay/protocol";

/** How long a room command waits for the desktop's answer before it counts as unconfirmed. */
export const ROOMS_TIMEOUT_MS = 30_000;
/** How long an answered command waits for the room frame to show it before the card frees up anyway. */
export const ROOMS_LAND_MS = 15_000;

export interface RoomsRequestInput {
  rid: string;
  /** What the room frame shows of the thing this command changes, when it was sent; null lands at once. */
  view?: string | null;
  /** Refused before sending: the request starts failed and sends nothing. */
  refused?: RoomsResult;
}

export interface RoomsRequestContext {
  rid: string;
  sentView: string | null;
  view: string | null;
  /** The desktop's answer, the host's or the local refusal; null while nothing answered. */
  result: RoomsResult | null;
}

export type RoomsRequestEvent =
  /** The `rooms.res` for this rid: the desktop's answer, or the host's. */
  | { type: "request.answered"; result: RoomsResult }
  /** Try again: send the same rid once more. */
  | { type: "request.retry" }
  /** The connection ended (socket epoch end, host switch): nothing will answer. */
  | { type: "request.cancelled"; result: RoomsResult }
  /** The room frame changed what the caller watches (its `view`). */
  | { type: "room.changed"; view: string };

/** Host answers that leave the desktop's outcome unknown. */
const UNKNOWN_OUTCOME: Partial<Record<string, true>> = { timeout: true, "device-gone": true };

const answer = [
  { guard: "outcomeUnknown", target: "unconfirmed", actions: "keepResult" },
  { guard: "refused", target: "failed", actions: "keepResult" },
  { target: "answered", actions: "keepResult" },
] as const;

export const roomsRequestMachine = setup({
  types: {
    context: {} as RoomsRequestContext,
    events: {} as RoomsRequestEvent,
    input: {} as RoomsRequestInput,
  },
  actions: {
    transmit: () => {
      // Supplied by the runtime (`PendingRooms.start`): sends `rooms.cmd` with this rid.
    },
    keepResult: assign({ result: ({ event }) => (event.type === "request.answered" || event.type === "request.cancelled" ? event.result : null) }),
    keepView: assign({ view: ({ context, event }) => (event.type === "room.changed" ? event.view : context.view) }),
  },
  guards: {
    refusedHere: ({ context }) => context.result !== null,
    outcomeUnknown: ({ event }) => event.type === "request.answered" && !event.result.ok && UNKNOWN_OUTCOME[event.result.code] === true,
    refused: ({ event }) => event.type === "request.answered" && !event.result.ok,
    shown: ({ context }) => context.sentView === null || context.view !== context.sentView,
  },
  delays: {
    answerTimeout: ROOMS_TIMEOUT_MS,
    landTimeout: ROOMS_LAND_MS,
  },
}).createMachine({
  id: "roomsRequest",
  context: ({ input }) => ({ rid: input.rid, sentView: input.view ?? null, view: input.view ?? null, result: input.refused ?? null }),
  initial: "sending",
  // The room frame can move before the answer arrives; `landing` then lands at once.
  on: { "room.changed": { actions: "keepView" } },
  states: {
    sending: {
      always: [{ guard: "refusedHere", target: "failed" }, { target: "pending" }],
    },
    pending: {
      entry: "transmit",
      after: { answerTimeout: "unconfirmed" },
      on: {
        "request.answered": [...answer],
        "request.cancelled": { target: "failed", actions: "keepResult" },
      },
    },
    unconfirmed: {
      on: {
        "request.answered": [...answer],
        "request.retry": { target: "pending", actions: assign({ result: null }) },
        "request.cancelled": { target: "failed", actions: "keepResult" },
      },
    },
    answered: {
      initial: "landing",
      states: {
        landing: {
          always: { guard: "shown", target: "landed" },
          after: { landTimeout: "landed" },
        },
        landed: { type: "final" },
      },
    },
    failed: { type: "final" },
  },
});

export type RoomsRequest = ActorRefFrom<typeof roomsRequestMachine>;
export type RoomsRequestSnapshot = SnapshotFrom<typeof roomsRequestMachine>;

/** What a card shows for a request: `busy` blocks every action on it, `unconfirmed` offers Try again. */
export type RoomsRequestPhase = "busy" | "unconfirmed" | "failed" | "done";

export function requestPhase(snapshot: RoomsRequestSnapshot): RoomsRequestPhase {
  if (snapshot.matches("unconfirmed")) return "unconfirmed";
  if (snapshot.matches("failed")) return "failed";
  if (snapshot.matches({ answered: "landed" })) return "done";
  return "busy";
}
