import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { fileStorage } from "./storage";

export type PointerSpeed = "slow" | "normal" | "fast";

export interface SettingsState {
  deviceName: string;
  hapticsEnabled: boolean;
  naturalScrolling: boolean;
  pointerSpeed: PointerSpeed;
  /** `host:port` that replaces Bonjour discovery; empty means discover automatically. */
  manualHost: string;
  set: (partial: Partial<Omit<SettingsState, "set">>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      deviceName: "iPhone",
      hapticsEnabled: true,
      naturalScrolling: true,
      pointerSpeed: "normal",
      manualHost: "",
      set: (partial) => {
        set(partial);
      },
    }),
    {
      name: "relay-settings",
      storage: createJSONStorage(() => fileStorage),
    },
  ),
);
