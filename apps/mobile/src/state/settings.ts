import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { fileStorage } from "./storage";

export type PointerSpeed = "slow" | "normal" | "fast";
/** `voz` is Desert Ant's on-device Parakeet model (no live partials, better on technical words); `apple` is iOS dictation. */
export type Recognizer = "apple" | "voz";

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
  /** Which speech recognizer hold-to-talk uses. `voz` falls back to `apple` until its model is downloaded. */
  recognizer: Recognizer;
  /** Thinking level new phone-started sessions open with; empty leaves omp's own default. */
  defaultThinkingLevel: string;
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
      recognizer: "voz",
      defaultThinkingLevel: "",
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
