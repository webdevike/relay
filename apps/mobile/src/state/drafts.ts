/**
 * Unsent composer text per chat thread, persisted, so a draft outlives the screen that holds it:
 * a trip into a live canvas and back, a remount, or the app being killed. Keys are
 * `draftKey(...)` values; an emptied draft is dropped rather than kept as "".
 */
import { useCallback } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { fileStorage } from "./storage";

export interface DraftsStore {
  drafts: Record<string, string>;
  setDraft: (thread: string, text: string) => void;
}

/** An assistant thread (`/eva?agent=`) or an omp session in the Agent Inbox. */
export function draftKey(kind: "assistant" | "session", id: string): string {
  return `${kind}:${id}`;
}

export const useDraftsStore = create<DraftsStore>()(
  persist(
    (set) => ({
      drafts: {},
      setDraft: (thread, text) => {
        set((state) => {
          if ((state.drafts[thread] ?? "") === text) return state;
          if (text !== "") return { drafts: { ...state.drafts, [thread]: text } };
          return { drafts: Object.fromEntries(Object.entries(state.drafts).filter(([key]) => key !== thread)) };
        });
      },
    }),
    { name: "relay-drafts", storage: createJSONStorage(() => fileStorage) },
  ),
);

type DraftUpdate = string | ((current: string) => string);

/** `useState("")` for a composer, kept in the store under `thread`; the setter takes an updater too. */
export function useThreadDraft(thread: string): [string, (next: DraftUpdate) => void] {
  const draft = useDraftsStore((state) => state.drafts[thread] ?? "");
  const setDraft = useCallback(
    (next: DraftUpdate) => {
      const store = useDraftsStore.getState();
      store.setDraft(thread, typeof next === "function" ? next(store.drafts[thread] ?? "") : next);
    },
    [thread],
  );
  return [draft, setDraft];
}