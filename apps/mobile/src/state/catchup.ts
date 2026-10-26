/**
 * The Catch Up deck as the host last reported it, plus this app session's "Keep Unread" order. Not
 * persisted: the driver asks with `catchup.list` on every welcome and the host pushes
 * `catchup.snapshot` whenever the feed or its state changes. `items` is null until the first answer.
 */
import { create } from "zustand";
import type { CatchUpCard, CatchUpSnapshot } from "@relay/protocol";
import { markRead, refreshDeferred } from "@/lib/catchup";

export interface CatchUpStore {
  items: CatchUpCard[] | null;
  unreadCount: number;
  /** Ids kept unread this session, oldest first: they go to the back of the deck. */
  deferred: string[];
  /** Bounce time per bounced card already shown, so a new bounce brings a kept card back to the front. */
  seenBounces: Record<string, string>;
  /** The host's last answer to a note; a new object for every answer, even for the same card. */
  noteAnswer: { id: string; ok: boolean } | null;
  set: (snapshot: CatchUpSnapshot | null) => void;
  /** Optimistic read state (and handoff), until the host's snapshot confirms it. */
  markLocal: (id: string, read: boolean, handedTo?: string) => void;
  defer: (id: string) => void;
  noted: (id: string, ok: boolean) => void;
}

export const useCatchUpStore = create<CatchUpStore>((set) => ({
  items: null,
  unreadCount: 0,
  deferred: [],
  seenBounces: {},
  noteAnswer: null,
  set: (snapshot) => {
    set((state) =>
      snapshot === null
        ? { items: null, unreadCount: 0 }
        : { items: snapshot.items, unreadCount: snapshot.unreadCount, ...refreshDeferred(snapshot.items, state.deferred, state.seenBounces) },
    );
  },
  markLocal: (id, read, handedTo) => {
    set((state) => (state.items === null ? {} : markRead(state.items, id, read, handedTo)));
  },
  defer: (id) => {
    set((state) => ({ deferred: [...state.deferred.filter((d) => d !== id), id] }));
  },
  noted: (id, ok) => {
    set({ noteAnswer: { id, ok } });
  },
}));
