/**
 * The swipe deck's motion as plain data, shared by the native Animated graph in `SwipeCard` and
 * its tests: the interpolation ranges, the cards' slots and keys, and `cardPose`, the pose that
 * graph shows for given native values (a JS twin of it, for checking frames without a device).
 *
 * After a throw the deck changes on two channels that iOS applies on different frames: the React
 * commit (the thrown card unmounts, the next card's face and overlay rerender) and the native
 * Animated queue (role weights flip, the shared motion resets to rest). Any state either one can
 * show first must look the same as before and after. So nothing visible switches through React:
 * every card draws the overlay weighted by its native `top`, and the thrown card's `presence` drops
 * to 0 on the native queue before the reset, so a reset that lands first never draws it back in
 * the middle. A card thrown back into the deck (Keep Unread on the last cards) gets a new key in
 * the same render, so its thrown instance is never reused.
 */

export type SwipeCardRole = "top" | "under" | "waiting";
export type SwipeDirection = "left" | "right" | "up";

/** Cards kept mounted: the top one, the one underneath, and the next, peeking behind it. */
export const SLOTS = 3;
export const ROLES: readonly SwipeCardRole[] = ["top", "under", "waiting"];

/** Share of the screen width a sideways drag must pass for a release to count. */
export const THRESHOLD_FRACTION = 0.35;
/** Share of the screen height an upward drag must pass for a release to count. */
export const UP_THRESHOLD_FRACTION = 0.14;
/** How far a card drops below the one above it; the stack needs twice this under the deck. */
export const STEP_DROP = 10;
/** Room to leave under the deck for the two cards peeking out below the top one. */
export const STACK_DROP = STEP_DROP * 2;
/** Each card down the stack is this much smaller than the one above it, toward its bottom edge. */
export const STEP_SCALE = 0.06;
export const MAX_TILT_DEG = 12;
/** The extra tilt a throw picks up on its way out. */
export const FLY_TILT_DEG = 18;
/** Where a sideways throw ends, in screen widths; an upward one, in screen heights. */
export const FLY_X = 1.5;
export const FLY_UP = 1.3;
/** The cards underneath move up a level over this share of the width (sideways) or height (up). */
const GROW_X = 0.8;
const GROW_UP = 0.4;

export type Extrapolate = "clamp" | "extend";

export interface Range {
  inputRange: number[];
  outputRange: number[];
  extrapolate: Extrapolate;
}

/** -1..1 sideways progress toward the left or right threshold. */
export function horizontalRange(width: number): Range {
  const threshold = width * THRESHOLD_FRACTION;
  return { inputRange: [-threshold, threshold], outputRange: [-1, 1], extrapolate: "clamp" };
}

/** 0..1 upward progress toward the up threshold, from the (negative) lift. */
export function upRange(height: number): Range {
  return { inputRange: [-height * UP_THRESHOLD_FRACTION, 0], outputRange: [1, 0], extrapolate: "clamp" };
}

/** Tilt in degrees from the card's sideways offset: up to `MAX_TILT_DEG` on the finger, more on the way out. */
export function tiltRange(width: number, reduceMotion: boolean): Range {
  const tilt = reduceMotion ? [0, 0, 0, 0, 0] : [-FLY_TILT_DEG, -MAX_TILT_DEG, 0, MAX_TILT_DEG, FLY_TILT_DEG];
  return { inputRange: [-width * FLY_X, -width / 2, 0, width / 2, width * FLY_X], outputRange: tilt, extrapolate: "clamp" };
}

/** 0..1 fade from the sideways offset: none while the finger can still hold it, gone by the screen edge and past. */
export function fadeXRange(width: number): Range {
  return { inputRange: [-width * 1.3, -width * 0.55, width * 0.55, width * 1.3], outputRange: [1, 0, 0, 1], extrapolate: "clamp" };
}

/** 0..1 fade from the lift. */
export function fadeUpRange(height: number): Range {
  return { inputRange: [-height * 1.1, -height * 0.3, 0], outputRange: [1, 0, 0], extrapolate: "clamp" };
}

/** 0..1: how far the cards underneath have moved up a level, from the sideways offset. */
export function growXRange(width: number): Range {
  return { inputRange: [-width * GROW_X, 0, width * GROW_X], outputRange: [1, 0, 1], extrapolate: "clamp" };
}

/** 0..1 the same, from the lift. */
export function growUpRange(height: number): Range {
  return { inputRange: [-height * GROW_UP, 0], outputRange: [1, 0], extrapolate: "clamp" };
}

/** Scale by stack level (0 top, 1 under, 2 behind); flat with Reduce Motion. */
export function levelScaleRange(reduceMotion: boolean): Range {
  return { inputRange: [0, 1, 2], outputRange: reduceMotion ? [1, 1, 1] : [1, 1 - STEP_SCALE, 1 - STEP_SCALE * 2], extrapolate: "clamp" };
}

/** Drop by stack level; none with Reduce Motion. */
export function levelDropRange(reduceMotion: boolean): Range {
  return { inputRange: [0, 1, 2], outputRange: reduceMotion ? [0, 0, 0] : [0, STEP_DROP, STEP_DROP * 2], extrapolate: "clamp" };
}

/** `Animated`'s piecewise-linear interpolation, for the twin. */
export function interpolate(value: number, range: Range): number {
  const { inputRange: input, outputRange: output, extrapolate } = range;
  const last = input.length - 1;
  const first = input[0] ?? 0;
  const end = input[last] ?? 0;
  if (extrapolate === "clamp") {
    if (value <= first) return output[0] ?? 0;
    if (value >= end) return output[last] ?? 0;
  }
  let segment = 0;
  while (segment < last - 1 && value > (input[segment + 1] ?? 0)) segment += 1;
  const from = input[segment] ?? 0;
  const to = input[segment + 1] ?? from;
  const fromOut = output[segment] ?? 0;
  const toOut = output[segment + 1] ?? fromOut;
  if (to === from) return fromOut;
  return fromOut + ((value - from) / (to - from)) * (toOut - fromOut);
}

/** One card's native weights: 1 for its role, 0 otherwise; `presence` 0..1 hides it whole. */
export interface CardWeights {
  top: number;
  under: number;
  waiting: number;
  presence: number;
}

/** The deck's shared motion at one frame: the top card's offset, its vertical drift and its lift (negative is up). */
export interface DeckMotionState {
  x: number;
  y: number;
  lift: number;
}

export interface DeckGeometry {
  width: number;
  height: number;
  reduceMotion: boolean;
}

export interface CardPose {
  translateX: number;
  translateY: number;
  scale: number;
  rotateDeg: number;
  opacity: number;
  /** How much of the action overlay shows (the strongest of its sides). */
  overlay: number;
}

export const REST: DeckMotionState = { x: 0, y: 0, lift: 0 };

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The pose `SwipeCard`'s native graph draws for these values (same ranges, same arithmetic). */
export function cardPose(weights: CardWeights, motion: DeckMotionState, geometry: DeckGeometry): CardPose {
  const { width, height, reduceMotion } = geometry;
  const grow = clamp01(interpolate(motion.x, growXRange(width)) + interpolate(motion.lift, growUpRange(height)));
  const level = weights.under * (1 - grow) + weights.waiting * (2 - grow);
  const ownX = motion.x * weights.top;
  const fade = clamp01(interpolate(motion.x, fadeXRange(width)) + interpolate(motion.lift, fadeUpRange(height)));
  const horizontal = interpolate(motion.x, horizontalRange(width));
  const up = interpolate(motion.lift, upRange(height));
  return {
    translateX: ownX,
    translateY: interpolate(level, levelDropRange(reduceMotion)) + (motion.y + motion.lift) * weights.top,
    scale: interpolate(level, levelScaleRange(reduceMotion)),
    rotateDeg: interpolate(ownX, tiltRange(width, reduceMotion)),
    opacity: weights.presence * (1 - weights.top * fade),
    overlay: weights.top * Math.max(Math.abs(horizontal), up),
  };
}

export function weightsFor(role: SwipeCardRole, presence = 1): CardWeights {
  return { top: role === "top" ? 1 : 0, under: role === "under" ? 1 : 0, waiting: role === "waiting" ? 1 : 0, presence };
}

/** Where a throw in `direction` leaves the deck's motion once it is done. */
export function thrownMotion(direction: SwipeDirection, geometry: Pick<DeckGeometry, "width" | "height">): DeckMotionState {
  if (direction === "up") return { x: 0, y: 0, lift: -geometry.height * FLY_UP };
  return { x: (direction === "right" ? 1 : -1) * geometry.width * FLY_X, y: 0, lift: 0 };
}

export interface DeckSlot<T> {
  item: T;
  /** The item's key plus how many times it has been thrown, so a card thrown back in mounts fresh. */
  key: string;
  role: SwipeCardRole;
}

/** The first `SLOTS` items as mounted cards, top first. */
export function deckSlots<T>(items: readonly T[], keyOf: (item: T) => string, throws: Readonly<Record<string, number>>): DeckSlot<T>[] {
  return items.slice(0, SLOTS).map((item, index) => {
    const id = keyOf(item);
    return { item, key: `${id}:${String(throws[id] ?? 0)}`, role: ROLES[index] ?? "waiting" };
  });
}
