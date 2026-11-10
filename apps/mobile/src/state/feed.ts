/**
 * Isaac's discovery feed as the host last reported it (`feed.snapshot`, answered to `feed.list` when the
 * Feed screen shows). Not persisted: the host's `feed.json` and `signals.jsonl` are the source.
 * `items` is null until the first answer.
 */
import { create } from "zustand";
import type { FeedAction, FeedItem, FeedSnapshot } from "@relay/protocol";

export interface FeedStore {
  items: FeedItem[] | null;
  generatedAt: string | null;
  /** id -> the action Isaac took, newest wins. */
  acted: Record<string, FeedAction>;
  set: (snapshot: FeedSnapshot | null) => void;
  /** Optimistic: the card shows liked, saved or gone at once; the host's next snapshot agrees. */
  actLocal: (id: string, action: FeedAction) => void;
}

export const useFeedStore = create<FeedStore>((set) => ({
  items: null,
  generatedAt: null,
  acted: {},
  set: (snapshot) => {
    set(snapshot === null ? { items: null, generatedAt: null, acted: {} } : { items: snapshot.items, generatedAt: snapshot.generatedAt, acted: snapshot.acted });
  },
  actLocal: (id, action) => {
    set((state) => ({ acted: { ...state.acted, [id]: action } }));
  },
}));
