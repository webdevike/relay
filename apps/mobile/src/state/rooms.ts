/**
 * Rooms as the phone last heard them: every room of every connected desktop, newest first. Not
 * persisted: the host relays them and the driver asks for the list on every (re)connection
 * (`rooms.get`). `supported` is whether the connected host's `welcome.features` has ROOMS_FEATURE;
 * null until the first welcome. Nothing rooms-related is sent while it is not true. `resumes` is
 * whether it also has ROOMS_RESUME_FEATURE (relays pause / resume); Pause and Resume show only then.
 * `chats` is whether it relays chat rooms (ROOMS_CHAT_FEATURE): only then does `rooms.get` ask for them.
 */
import { create } from "zustand";
import type { RoomWire } from "@relay/protocol";

export interface RoomsStore {
  supported: boolean | null;
  resumes: boolean;
  chats: boolean;
  /** False until the first `rooms.state` from this host. */
  loaded: boolean;
  /** Newest first. */
  rooms: RoomWire[];
  setSupported: (supported: boolean, resumes?: boolean, chats?: boolean) => void;
  /** `rooms.state`: replaces every room. */
  setState: (rooms: readonly unknown[]) => void;
  /** `rooms.room`: replaces the room with the same id, or inserts it. */
  upsert: (room: unknown) => void;
  /** Another host: everything this one said goes. */
  clear: () => void;
}

const newestFirst = (a: RoomWire, b: RoomWire) => b.startedAt - a.startedAt;

/**
 * A room frame as a RoomWire. The host passes the desktop's room through untouched and only
 * checks its id, title, phase and start, so every list the screens map over is made sure of here.
 * Null for something that is not a room.
 */
export function asRoom(raw: unknown): RoomWire | null {
  if (typeof raw !== "object" || raw === null) return null;
  const room = raw as Partial<RoomWire>;
  if (typeof room.id !== "string" || room.id === "" || typeof room.startedAt !== "number") return null;
  return {
    ...room,
    id: room.id,
    title: typeof room.title === "string" ? room.title : "",
    prompt: typeof room.prompt === "string" ? room.prompt : "",
    agents: Array.isArray(room.agents) ? room.agents : [],
    messages: Array.isArray(room.messages) ? room.messages : [],
    presence: room.presence ?? {},
    phase: room.phase ?? "open",
    rounds: typeof room.rounds === "number" ? room.rounds : 0,
    startedAt: room.startedAt,
  };
}

export const useRoomsStore = create<RoomsStore>((set) => ({
  supported: null,
  resumes: false,
  chats: false,
  loaded: false,
  rooms: [],
  setSupported: (supported, resumes = false, chats = false) => {
    set({ supported, resumes: supported && resumes, chats: supported && chats });
  },
  setState: (frames) => {
    const rooms = frames.map(asRoom).filter((room): room is RoomWire => room !== null);
    set({ loaded: true, rooms: rooms.sort(newestFirst) });
  },
  upsert: (frame) => {
    const room = asRoom(frame);
    if (room === null) return;
    set((state) => ({ rooms: [...state.rooms.filter((r) => r.id !== room.id), room].sort(newestFirst) }));
  },
  clear: () => {
    set({ supported: null, resumes: false, chats: false, loaded: false, rooms: [] });
  },
}));

/** The room with this id, or undefined. */
export function useRoom(id: string | undefined): RoomWire | undefined {
  return useRoomsStore((state) => state.rooms.find((room) => room.id === id));
}
