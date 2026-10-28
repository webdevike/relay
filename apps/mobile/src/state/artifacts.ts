/**
 * Each thread's artifacts and tab bar (`assistant:<id>` or `session:<id>`), as the host's last
 * `artifacts.snapshot` said. Not persisted: the host owns them; a screen showing a thread asks with
 * `artifacts.get` (`watchArtifacts`), the driver again after every reconnect, and the host pushes a
 * new snapshot to every device after each change. Pins and tab edits show at once (`pin`,
 * `patchTab`); the next snapshot is authoritative.
 */
import { create } from "zustand";
import type { Artifact, ArtifactPin, ArtifactTab } from "@relay/protocol";

export interface ThreadArtifacts {
  items: Artifact[];
  /** Bar order, hidden tabs included. */
  tabs: ArtifactTab[];
}

export type TabPatch = Partial<Pick<ArtifactTab, "title" | "hidden" | "fresh">>;

export interface ArtifactsStore {
  threads: Record<string, ThreadArtifacts>;
  /** The host's snapshot of `thread`, replacing whatever was shown for it. */
  set: (thread: string, snapshot: ThreadArtifacts) => void;
  /** Optimistic: item `id` pinned with `pin`, or unpinned for undefined. */
  pin: (thread: string, id: string, pin: ArtifactPin | undefined) => void;
  /** Optimistic: a tab renamed, hidden or shown, or its blue dot cleared. */
  patchTab: (thread: string, tab: string, patch: TabPatch) => void;
  /** Forget every thread (another host). */
  clear: () => void;
}

export const useArtifactsStore = create<ArtifactsStore>((set) => ({
  threads: {},
  set: (thread, snapshot) => {
    set((state) => ({ threads: { ...state.threads, [thread]: snapshot } }));
  },
  pin: (thread, id, pin) => {
    set((state) => {
      const current = state.threads[thread];
      if (current === undefined) return {};
      const items = current.items.map((item) => {
        if (item.id !== id) return item;
        const next = { ...item };
        delete next.pinned;
        return pin === undefined ? next : { ...next, pinned: pin };
      });
      return { threads: { ...state.threads, [thread]: { ...current, items } } };
    });
  },
  patchTab: (thread, tab, patch) => {
    set((state) => {
      const current = state.threads[thread];
      if (current === undefined) return {};
      const tabs = current.tabs.map((entry) => (entry.id === tab ? { ...entry, ...patch } : entry));
      return { threads: { ...state.threads, [thread]: { ...current, tabs } } };
    });
  },
  clear: () => {
    set({ threads: {} });
  },
}));
