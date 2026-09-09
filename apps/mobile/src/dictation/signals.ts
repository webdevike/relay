/**
 * UI-thread signals shared between the mic button and the trackpad's centered orb. Reanimated
 * mutables so gestures and the mic meter animate without re-rendering React; the discrete state
 * (phase, submit, launches) lives in the dictation actor.
 */
import { makeMutable } from "react-native-reanimated";

/** 0..1 normalized microphone level while listening, decays to 0 otherwise. */
export const micLevel = makeMutable(0);
/** 0..1 how far the finger has dragged up toward the send threshold while holding the mic. */
export const sendLift = makeMutable(0);
