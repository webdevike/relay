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
/**
 * Continuous index into the skill list while the wheel is open: 0 is the first skill, 1 the
 * next, fractional between. Unbounded; the list wraps, so entry `i` sits at every `i + k * n`.
 */
export const wheelPosition = makeMutable(0);
/** 1 the instant an entry crosses the selection axis, decaying to 0: the detent tick. */
export const wheelDetent = makeMutable(0);
/** 1 the instant the wheel locks onto the picked entry, decaying to 0: the confirmation bloom. */
export const wheelConfirm = makeMutable(0);
