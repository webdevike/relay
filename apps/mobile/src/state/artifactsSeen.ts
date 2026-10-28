/**
 * When Isaac last opened the Artifacts sheet on each thread (epoch ms), kept on the phone so the
 * header button's blue dot (`hasNewArtifacts`) survives a restart. Local only: each device has its
 * own idea of what Isaac has seen there.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { fileStorage } from "./storage";

export interface ArtifactsSeenStore {
  seen: Record<string, number>;
  markSeen: (thread: string, at: number) => void;
}

export const useArtifactsSeenStore = create<ArtifactsSeenStore>()(
  persist(
    (set) => ({
      seen: {},
      markSeen: (thread, at) => {
        set((state) => ({ seen: { ...state.seen, [thread]: Math.max(at, state.seen[thread] ?? 0) } }));
      },
    }),
    { name: "relay-artifacts-seen", storage: createJSONStorage(() => fileStorage) },
  ),
);
