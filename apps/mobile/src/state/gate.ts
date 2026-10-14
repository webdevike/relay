/**
 * The habit gate as the host last reported it. Not persisted: the host pushes `gate.status` on
 * every change and the driver asks with `gate.get` on every welcome, so a cached copy could only
 * be stale. `null`: this host reports no gate (no omp session, or no gate CLI on it).
 */
import { create } from "zustand";
import type { GateStatus } from "@relay/protocol";

export interface GateStore {
  gate: GateStatus | null;
  set: (gate: GateStatus | null) => void;
}

export const useGateStore = create<GateStore>((set) => ({
  gate: null,
  set: (gate) => {
    set({ gate });
  },
}));
