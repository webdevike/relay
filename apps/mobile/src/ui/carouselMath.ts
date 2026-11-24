/**
 * The looping card carousel (`ui/CardCarousel`) as plain numbers shared by its gesture and its tests:
 * where each card sits around the one in front, how a side card fades, who takes a swipe, and what a
 * released swipe does (next, previous, collapse, or spring back). Values follow the Relay ask-cards
 * prototype (`mobile.tsx`).
 *
 * Pure worklets, so the gesture runs them on the UI thread and tests run them in Node. No default
 * parameters: a worklet's default that names a module constant is not captured and crashes.
 */

/** The screen width a card leaves free: 36 pt each side, where the next and previous cards peek in. */
export const CARD_INSET = 72;
/** A card is never narrower than this. */
export const MIN_CARD_WIDTH = 220;
/** Space between two neighbouring cards. */
export const CARD_GAP = 12;
/** A side card's opacity and scale, reached one card away from the front. */
export const SIDE_OPACITY = 0.5;
export const SIDE_SCALE = 0.94;
/** Points the finger travels before a swipe is decided. */
export const CAROUSEL_SLOP = 10;
/** A sideways release this far (after the fling projection) moves one card. */
export const STEP_DISTANCE = 60;
/** A mostly downward release this far (after the fling projection) collapses the carousel. */
export const COLLAPSE_DISTANCE = 90;
/** Seconds of release velocity added to the distance: a quick flick counts as a longer drag. */
export const FLING_PROJECTION = 0.15;

/** A card's width on a screen `screenWidth` wide. */
export function carouselCardWidth(screenWidth: number): number {
  "worklet";
  return Math.max(MIN_CARD_WIDTH, screenWidth - CARD_INSET);
}

/**
 * Where card `index` sits relative to card `front` among `count` cards that loop, in card steps:
 * 0 in front, 1 to its right, -1 to its left, never more than half the cards either way (so the
 * card after the last one peeks in right of it, the first one again).
 */
export function loopSlot(index: number, front: number, count: number): number {
  "worklet";
  if (count <= 0) return 0;
  const ahead = (((index - front) % count) + count) % count;
  return ahead > count / 2 ? ahead - count : ahead;
}

/** How far a card at `offset` points from the middle is toward a side card: 0 in front, 1 one step (`step`) away or more. */
export function sideness(offset: number, step: number): number {
  "worklet";
  if (step <= 0) return 0;
  return Math.min(1, Math.abs(offset) / step);
}

/**
 * Who takes a swipe that has travelled `dx`, `dy`: `undecided` until it has gone `CAROUSEL_SLOP`;
 * `carousel` when it runs more sideways than vertically, or mostly down (to collapse); `none` when it
 * runs mostly up, which is left to whatever scrolls inside the card.
 */
export type CarouselOwner = "undecided" | "carousel" | "none";

export function carouselOwner(dx: number, dy: number): CarouselOwner {
  "worklet";
  if (Math.abs(dx) < CAROUSEL_SLOP && Math.abs(dy) < CAROUSEL_SLOP) return "undecided";
  if (Math.abs(dx) > Math.abs(dy)) return "carousel";
  return dy > 0 ? "carousel" : "none";
}

/**
 * What releasing a swipe does, from how far it went (`dx`, `dy`) and how fast (`vx`, `vy`, points
 * per second): `collapse` for a mostly downward one past `COLLAPSE_DISTANCE`, 1 (next card) or -1
 * (previous) for a sideways one past `STEP_DISTANCE` to the left or right, else 0 (spring back).
 */
export function carouselRelease(dx: number, dy: number, vx: number, vy: number): "collapse" | -1 | 0 | 1 {
  "worklet";
  const down = dy + vy * FLING_PROJECTION;
  const side = dx + vx * FLING_PROJECTION;
  if (Math.abs(dy) > Math.abs(dx) && down > COLLAPSE_DISTANCE) return "collapse";
  if (Math.abs(dy) > Math.abs(dx)) return 0;
  if (side < -STEP_DISTANCE) return 1;
  if (side > STEP_DISTANCE) return -1;
  return 0;
}
