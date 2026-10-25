/**
 * The Catch Up deck as the host last reported it, plus this app session's "Keep Unread" order. Not
 * persisted: the driver asks with `catchup.list` on every welcome and the host pushes
 * `catchup.snapshot` whenever the feed or read state changes. `items` is null until the first answer.
 */
import { create } from "zustand";
import type { CatchUpCard, CatchUpSnapshot } from "@relay/protocol";
import { markRead } from "@/lib/catchup";

export interface CatchUpStore {
  items: CatchUpCard[] | null;
  unreadCount: number;
  /** Ids kept unread this session, oldest first: they go to the back of the deck. */
  deferred: string[];
  set: (snapshot: CatchUpSnapshot | null) => void;
  /** Optimistic read state, until the host's snapshot confirms it. */
  markLocal: (id: string, read: boolean) => void;
  defer: (id: string) => void;
}

export const useCatchUpStore = create<CatchUpStore>((set) => ({
  items: null,
  unreadCount: 0,
  deferred: [],
  set: (snapshot) => {
    set(snapshot === null ? { items: null, unreadCount: 0 } : { items: snapshot.items, unreadCount: snapshot.unreadCount });
  },
  markLocal: (id, read) => {
    set((state) => (state.items === null ? {} : markRead(state.items, id, read)));
  },
  defer: (id) => {
    set((state) => ({ deferred: [...state.deferred.filter((d) => d !== id), id] }));
  },
}));
