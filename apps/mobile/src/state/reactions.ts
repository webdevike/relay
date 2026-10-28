/**
 * Reactions on chat bubbles, by thread (`assistant:<id>` or `session:<id>`), then by bubble key
 * (`reactionKey`), then by reactor: Isaac (`ISAAC_REACTOR`) or an assistant by its agent id. Not
 * persisted: the host owns them, a thread's screen asks with `reactions.get` when it opens and the
 * driver again after every reconnect, and the host pushes `reactions.snapshot` to every device
 * whenever a thread's reactions change. Isaac's tap shows at once (`setLocal`); the next snapshot
 * is authoritative.
 */
import { create } from "zustand";
import { ISAAC_REACTOR, type Reaction, type ThreadReactions } from "@relay/protocol";
import { withReaction } from "@/lib/reactions";

export interface ReactionsStore {
  threads: Record<string, ThreadReactions>;
  /** The host's snapshot of `thread`, replacing whatever was shown for it. */
  set: (thread: string, reactions: ThreadReactions) => void;
  /** Optimistic: Isaac reacted `emoji` to bubble `key` of `thread`, or took his reaction back for null. */
  setLocal: (thread: string, key: string, emoji: string | null, excerpt: string, at: number) => void;
  /** Forget every thread (another host). */
  clear: () => void;
}

const NONE: Readonly<ThreadReactions> = {};

export const useReactionsStore = create<ReactionsStore>((set) => ({
  threads: {},
  set: (thread, reactions) => {
    set((state) => ({ threads: { ...state.threads, [thread]: reactions } }));
  },
  setLocal: (thread, key, emoji, excerpt, at) => {
    set((state) => {
      const current = state.threads[thread] ?? NONE;
      const next = withReaction(current, key, ISAAC_REACTOR, emoji, excerpt, at);
      return next === current ? {} : { threads: { ...state.threads, [thread]: next } };
    });
  },
  clear: () => {
    set({ threads: {} });
  },
}));

/** Isaac's emoji on bubble `key` of `thread`, or null; a selector-friendly read for one bubble. */
export function useBubbleReaction(thread: string | null, key: string | null): string | null {
  return useReactionsStore((state) => (thread === null || key === null ? null : (state.threads[thread]?.[key]?.[ISAAC_REACTOR]?.emoji ?? null)));
}

/** Everyone's reactions on bubble `key` of `thread` by reactor, or undefined for none; the store's own object, so it only changes when they do. */
export function useBubbleReactions(thread: string | null, key: string | null): Readonly<Record<string, Reaction>> | undefined {
  return useReactionsStore((state) => (thread === null || key === null ? undefined : state.threads[thread]?.[key]));
}
