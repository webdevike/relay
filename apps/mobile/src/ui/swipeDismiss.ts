/**
 * When a swipe on a status card dismisses it, as plain numbers shared by the card's gesture and its
 * tests. Only a leftward drag counts: it dismisses on release once it has passed a share of the
 * card's width, or when it is a quick flick that has moved a little. Anything else springs back.
 *
 * Pure worklets, so the gesture runs them on the UI thread and tests run them in Node. No default
 * parameters: a worklet's default that names a module constant is not captured and crashes.
 */

/** Share of the card's width a leftward drag must pass for a release to dismiss. */
export const DISMISS_FRACTION = 0.35;
/** A leftward flick faster than this (points per second) dismisses ... */
export const DISMISS_VELOCITY = 800;
/** ... once the card has moved at least this far (points), so a twitch never does. */
export const FLICK_MIN_DISTANCE = 32;
/** A rightward drag follows the finger this much (a rubber band), never more. */
export const RUBBER_BAND = 0.15;

/** Where the card sits for a drag of `translationX`: free to the left, a short rubber band to the right. */
export function dragOffset(translationX: number): number {
  "worklet";
  return translationX < 0 ? translationX : translationX * RUBBER_BAND;
}

/** Whether releasing a drag (`translationX`, `velocityX` as the gesture reports them) on a card `width` wide dismisses it. */
export function shouldDismissSwipe(translationX: number, velocityX: number, width: number): boolean {
  "worklet";
  if (width <= 0 || translationX >= 0) return false;
  if (-translationX >= width * DISMISS_FRACTION) return true;
  return -velocityX >= DISMISS_VELOCITY && -translationX >= FLICK_MIN_DISTANCE;
}
