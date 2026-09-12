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
  /** Swipe left while holding the inbox mic opens the skill wheel. Off until it is finished. */
  skillWheelEnabled: boolean;
  /** Push a notification when a session starts waiting on the user. Requires system permission. */
  notificationsEnabled: boolean;
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
      skillWheelEnabled: false,
      notificationsEnabled: false,
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
