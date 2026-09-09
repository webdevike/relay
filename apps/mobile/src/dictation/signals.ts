/**
 * Dictation state shared beyond the button: the trackpad's centered orb reads these. `micLevel`
 * is a Reanimated mutable so the UI thread can animate off it without re-rendering React.
 */
import { makeMutable } from "react-native-reanimated";
import { create } from "zustand";
import type { DictationPhase } from "./machine";

/** 0..1 normalized microphone level while listening, decays to 0 otherwise. */
export const micLevel = makeMutable(0);

interface DictationStore {
  phase: DictationPhase;
  setPhase: (phase: DictationPhase) => void;
  /** Incremented when a submitted dictation is released; the overlay flies a plane per launch. */
  launches: number;
  launch: () => void;
  /** The in-flight/last send also pressed Return. */
  submitted: boolean;
  setSubmitted: (submitted: boolean) => void;
}

export const useDictationStore = create<DictationStore>((set) => ({
  phase: "idle",
  setPhase: (phase) => {
    set({ phase });
  },
  submitted: false,
  setSubmitted: (submitted) => {
    set({ submitted });
  },
  launches: 0,
  launch: () => {
    set((s) => ({ launches: s.launches + 1 }));
  },
}));
