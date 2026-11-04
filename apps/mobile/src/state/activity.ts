/**
 * What agents are running on the host (helpers, sessions, harnesses, canvas rooms), as its last
 * `activity.snapshot` listed them. Not persisted: the driver asks with `activity.get` on every
 * welcome and the host pushes a new list after every change. Empty until the first answer.
 */
import { create } from "zustand";
import type { ActivityItem } from "@relay/protocol";

export interface ActivityStore {
  items: readonly ActivityItem[];
  set: (items: readonly ActivityItem[]) => void;
}

export const useActivityStore = create<ActivityStore>((set) => ({
  items: [],
  set: (items) => {
    set({ items });
  },
}));
