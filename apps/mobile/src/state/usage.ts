/**
 * Plan usage of every omp account on the host, as it last reported it. Not persisted: the driver
 * asks with `usage.get` on every welcome and the host pushes `usage.snapshot` whenever a refresh
 * starts or ends. `null` until the first answer.
 */
import { create } from "zustand";
import type { UsageSnapshot } from "@relay/protocol";

export interface UsageStore {
  usage: UsageSnapshot | null;
  set: (usage: UsageSnapshot | null) => void;
}

export const useUsageStore = create<UsageStore>((set) => ({
  usage: null,
  set: (usage) => {
    set({ usage });
  },
}));
