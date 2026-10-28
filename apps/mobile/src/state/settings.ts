import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { fileStorage } from "./storage";
import { DEFAULT_WIDGETS, normalizeWidgets, withWidgetOnce, type HomeWidget } from "@/home/widgets/layout";

export type PointerSpeed = "slow" | "normal" | "fast";
/** `voz` is Desert Ant's on-device Parakeet model (no live partials, better on technical words); `apple` is iOS dictation. */
export type Recognizer = "apple" | "voz";
/** `system` follows the iOS appearance; `light`/`dark` pin the app regardless of it. */
export type AppearanceChoice = "system" | "light" | "dark";

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
  appearance: AppearanceChoice;
  /** Playback speed for audio widgets; the last choice carries to the next clip. */
  audioRate: number;
  /** Home's widgets in grid order, per device. Empty when the user removed them all. */
  homeWidgets: HomeWidget[];
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
      appearance: "system",
      audioRate: 1,
      homeWidgets: DEFAULT_WIDGETS.map((w) => ({ ...w })),
      set: (partial) => {
        set(partial);
      },
    }),
    {
      name: "relay-settings",
      storage: createJSONStorage(() => fileStorage),
      // v1: `ompProfile` lost its "" (host's current account) choice.
      // v2: Home widgets; a build without them gets the default layout.
      // v3: Home's app list became the `apps` widget; a layout saved before then gets it once.
      // v4: Catch Up; a layout saved before then gets a medium one on top, once.
      // v5: Home's Work | Personal switch is gone; a saved `ompProfile` is dropped so nothing filters by it.
      version: 5,
      migrate: (persisted, version) => {
        const state: Partial<SettingsState> & { ompProfile?: unknown } = { ...(persisted as Partial<SettingsState>) };
        delete state.ompProfile;
        let widgets = normalizeWidgets(state.homeWidgets);
        if (version < 3) widgets = withWidgetOnce(widgets, "apps", "large", "end");
        if (version < 4) widgets = withWidgetOnce(widgets, "catchup", "medium", "start");
        return { ...state, homeWidgets: widgets };
      },
    },
  ),
);
