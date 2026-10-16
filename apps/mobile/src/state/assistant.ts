/**
 * Eva's conversation as the host last sent it. Not persisted: the host owns the transcript and
 * replays it on `assistant.get` (asked while the Eva screen is on screen) and after every turn.
 * `pending` is the phone's optimistic echo of a sent turn, shown until a snapshot carries it.
 */
import { create } from "zustand";
import type { AssistantSnapshot } from "@relay/protocol";

export interface PendingTurn {
  text: string;
  /** The snapshot rev held when the turn was sent; any later rev means the host has taken it. */
  sinceRev: number;
}

export interface AssistantStore {
  snapshot: AssistantSnapshot | null;
  pending: PendingTurn | null;
  set: (snapshot: AssistantSnapshot) => void;
  setPending: (text: string | null) => void;
}

/**
 * A snapshot that lists the echoed words as a user message, or that moved past the rev held at
 * send time (the host's transcript changed after the turn went up), retires the echo.
 */
export function settlePending(snapshot: AssistantSnapshot, pending: PendingTurn | null): PendingTurn | null {
  if (pending === null) return null;
  if (snapshot.rev > pending.sinceRev) return null;
  return snapshot.messages.some((message) => message.role === "user" && message.text === pending.text) ? null : pending;
}

export const useAssistantStore = create<AssistantStore>((set, get) => ({
  snapshot: null,
  pending: null,
  set: (snapshot) => {
    set({ snapshot, pending: settlePending(snapshot, get().pending) });
  },
  setPending: (text) => {
    set({ pending: text === null ? null : { text, sinceRev: get().snapshot?.rev ?? -1 } });
  },
}));
