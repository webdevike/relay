/**
 * The drop box as the phone last heard it. Not persisted: the host owns the history and the
 * driver asks for the whole list on every (re)connection, so anything cached here would only be
 * stale between launches. Kept newest first so screens can render it as-is.
 */
import { create } from "zustand";
import type { Drop } from "@relay/protocol";

export interface DropsStore {
  drops: Drop[];
  setAll: (drops: Drop[]) => void;
  /** Replaces the drop with the same id, or inserts it; the list stays newest first. */
  upsert: (drop: Drop) => void;
  remove: (id: string) => void;
}

export const useDropsStore = create<DropsStore>((set, get) => ({
  drops: [],
  setAll: (drops) => {
    set({ drops: [...drops].sort((a, b) => b.createdAt - a.createdAt) });
  },
  upsert: (drop) => {
    const drops = get().drops.filter((existing) => existing.id !== drop.id);
    drops.push(drop);
    set({ drops: drops.sort((a, b) => b.createdAt - a.createdAt) });
  },
  remove: (id) => {
    const drops = get().drops;
    const next = drops.filter((drop) => drop.id !== id);
    if (next.length !== drops.length) set({ drops: next });
  },
}));
