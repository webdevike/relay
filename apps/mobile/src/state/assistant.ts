/**
 * Eva's conversation as the host last sent it. Not persisted: the host owns the transcript and
 * replays it on `assistant.get` (asked while the Eva screen is on screen) and after every turn.
 * `pending` is the phone's optimistic echo of a sent turn, shown until a snapshot carries it.
 */
import { create } from "zustand";
import type { AssistantSnapshot } from "@relay/protocol";
import type { Photo } from "@/lib/photo";

export interface PendingTurn {
  text: string;
  /** The photos sent with the turn, kept so the echo bubble can show them until the host lists refs. */
  images: Photo[];
  /** The snapshot rev held when the turn was sent; any later rev means the host has taken it. */
  sinceRev: number;
}

export interface AssistantStore {
  snapshot: AssistantSnapshot | null;
  pending: PendingTurn | null;
  /** Messages whose sign-in the host took, shown submitted before its snapshot says so. */
  signedIn: Record<string, true>;
  set: (snapshot: AssistantSnapshot) => void;
  /** Echo a sent turn; null clears it. */
  setPending: (turn: { text: string; images: Photo[] } | null) => void;
  /** The host acked the credentials for this message. */
  markSignedIn: (messageId: string) => void;
}

/**
 * A snapshot that lists the echoed words as a user message, or that moved past the rev held at
 * send time (the host's transcript changed after the turn went up), retires the echo. An
 * image-only turn has no words to match, so it waits for the rev to move.
 */
export function settlePending(snapshot: AssistantSnapshot, pending: PendingTurn | null): PendingTurn | null {
  if (pending === null) return null;
  if (snapshot.rev > pending.sinceRev) return null;
  if (pending.text === "") return pending;
  return snapshot.messages.some((message) => message.role === "user" && message.text === pending.text) ? null : pending;
}

export const useAssistantStore = create<AssistantStore>((set, get) => ({
  snapshot: null,
  pending: null,
  signedIn: {},
  set: (snapshot) => {
    set({ snapshot, pending: settlePending(snapshot, get().pending) });
  },
  setPending: (turn) => {
    set({ pending: turn === null ? null : { ...turn, sinceRev: get().snapshot?.rev ?? -1 } });
  },
  markSignedIn: (messageId) => {
    set({ signedIn: { ...get().signedIn, [messageId]: true } });
  },
}));
