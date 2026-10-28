/**
 * Live canvas rooms as the host last listed them (`canvas.rooms`), and the way into each board's
 * room as it last answered `canvas.open`. Not persisted: the host owns both, and a new connection
 * asks again (`canvas.get` on every welcome).
 */
import { create } from "zustand";
import type { CanvasRoomInfo } from "@relay/protocol";

export type CanvasAccessState =
  | { readonly kind: "asking" }
  /** Load `url` (the host's web client, token included) until `expiresAt`; reloads reuse it. */
  | { readonly kind: "ready"; readonly url: string; readonly expiresAt: number }
  /** No live room on the board: the session ended. `reason` is one line for the screen. */
  | { readonly kind: "unavailable"; readonly reason: string };

export interface CanvasStore {
  /** The rev of the last list applied; -1 before the host has sent one on this connection target. */
  rev: number;
  /** Every room the host holds, live or ended, keyed by id. */
  rooms: Record<string, CanvasRoomInfo>;
  /** Per board slug: the last `canvas.open` answer, or `asking` while one is out. */
  access: Record<string, CanvasAccessState>;
  setRooms: (rev: number, rooms: readonly CanvasRoomInfo[]) => void;
  setAccess: (slug: string, access: CanvasAccessState) => void;
  /** The connection moved to another host: nothing the last one said holds. */
  clear: () => void;
  /**
   * A new connection was welcomed: the host may have restarted, so its revs start over and the
   * tokens it issued are gone. Keep the rooms until its list arrives and any open still being asked.
   */
  reconnected: () => void;
}

export const useCanvasStore = create<CanvasStore>((set) => ({
  rev: -1,
  rooms: {},
  access: {},
  setRooms: (rev, rooms) => {
    set((state) => {
      // Pushes and answers can cross on the wire; an older list never replaces a newer one.
      if (rev < state.rev) return state;
      // A token is kept for re-entering a live room only: once the board has none, the next Join
      // asks again (a fresh token for a new session there, or word that it ended).
      const live = new Set(rooms.filter((room) => room.live).map((room) => room.slug));
      const access = Object.fromEntries(Object.entries(state.access).filter(([slug, entry]) => entry.kind !== "ready" || live.has(slug)));
      return { rev, rooms: Object.fromEntries(rooms.map((room) => [room.id, room])), access };
    });
  },
  setAccess: (slug, access) => {
    set((state) => ({ access: { ...state.access, [slug]: access } }));
  },
  clear: () => {
    set({ rev: -1, rooms: {}, access: {} });
  },
  reconnected: () => {
    set((state) => ({ rev: -1, access: Object.fromEntries(Object.entries(state.access).filter(([, entry]) => entry.kind === "asking")) }));
  },
}));

/** What a Join card can do: open the live room, say it ended, or wait for the host's list. */
export type CanvasJoinState = "live" | "ended" | "unknown";

/**
 * A card belongs to one room (`roomId`): it is live while that room is, and ended once the host
 * lists it ended or no longer holds it. A later session on the same board is a different room
 * with its own card. Before this connection has a list there is no telling.
 */
export function canvasJoinState(state: Pick<CanvasStore, "rev" | "rooms">, roomId: string): CanvasJoinState {
  const room = state.rooms[roomId];
  if (room !== undefined) return room.live ? "live" : "ended";
  return state.rev < 0 ? "unknown" : "ended";
}

/** The live room on `slug`, if any: the canvas screen's header and its ended state read it. */
export function liveRoomOn(rooms: Record<string, CanvasRoomInfo>, slug: string): CanvasRoomInfo | undefined {
  return Object.values(rooms).find((room) => room.slug === slug && room.live);
}

/** A ready token is reused until shortly before it lapses, so re-entering never reloads the room. */
const EXPIRY_MARGIN_MS = 60_000;

export function usableAccess(access: CanvasAccessState | undefined, now: number): access is Extract<CanvasAccessState, { kind: "ready" }> {
  return access?.kind === "ready" && access.expiresAt - EXPIRY_MARGIN_MS > now;
}
