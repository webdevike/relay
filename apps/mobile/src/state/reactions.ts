/**
 * Isaac's reactions on chat bubbles, by thread (`assistant:<id>` or `session:<id>`) and then by
 * bubble key (`reactionKey`). Not persisted: the host owns them, a thread's screen asks with
 * `reactions.get` when it opens and the driver again after every reconnect, and the host pushes
 * `reactions.snapshot` to every device whenever a thread's reactions change. A tap shows at once
 * (`setLocal`); the next snapshot is authoritative.
 */
import { create } from "zustand";
import type { Reaction, ThreadReactions } from "@relay/protocol";
import { withReaction } from "@/lib/reactions";

export interface ReactionsStore {
  threads: Record<string, Record<string, Reaction>>;
  /** The host's snapshot of `thread`, replacing whatever was shown for it. */
  set: (thread: string, reactions: ThreadReactions) => void;
  /** Optimistic: bubble `key` of `thread` reacted `emoji`, or cleared for null. */
  setLocal: (thread: string, key: string, emoji: string | null, excerpt: string, at: number) => void;
  /** Forget every thread (another host). */
  clear: () => void;
}

const NONE: Readonly<Record<string, Reaction>> = {};

export const useReactionsStore = create<ReactionsStore>((set) => ({
  threads: {},
  set: (thread, reactions) => {
    set((state) => ({ threads: { ...state.threads, [thread]: reactions } }));
  },
  setLocal: (thread, key, emoji, excerpt, at) => {
    set((state) => {
      const current = state.threads[thread] ?? NONE;
      const next = withReaction(current, key, emoji, excerpt, at);
      return next === current ? {} : { threads: { ...state.threads, [thread]: next } };
    });
  },
  clear: () => {
    set({ threads: {} });
  },
}));

/** The emoji on bubble `key` of `thread`, or null; a selector-friendly read for one bubble. */
export function useBubbleReaction(thread: string | null, key: string | null): string | null {
  return useReactionsStore((state) => (thread === null || key === null ? null : (state.threads[thread]?.[key]?.emoji ?? null)));
}
