/**
 * The iOS keyboard's own motion, as a time curve: Reanimated's measured fit of it
 * (REAKeyboardEventObserver `estimateOpeningKeyboardHeight` / `estimateClosingKeyboardHeight`,
 * https://www.desmos.com/calculator/ufy5rbucpd and /vhrhdaopyq). Opening takes about 480 ms,
 * closing about 496 ms; both start fast and land softly, as the keyboard does. Worklets, so the
 * UI thread runs them every frame.
 */

/** How long the keyboard takes to rise, in ms. */
export const KEYBOARD_OPEN_MS = 480;
/** How long the keyboard takes to fall, in ms. */
export const KEYBOARD_CLOSE_MS = 496;

function fit(x: number, a1: number, a2: number, b1: number, b2: number, c1: number, c2: number): number {
  "worklet";
  const t = Math.min(1, Math.max(0, x));
  const u = 1 - t;
  return 1 - a1 * u ** a2 - b1 * t * u ** b2 - c1 * t * t * u ** c2;
}

/** Share of the way risen at `x` (0 to 1) of `KEYBOARD_OPEN_MS`. */
export function keyboardOpening(x: number): number {
  "worklet";
  return fit(x, 1, 4.62, 2.44, 9.82, 0.22, 2.09);
}

/** Share of the way fallen at `x` (0 to 1) of `KEYBOARD_CLOSE_MS`. */
export function keyboardClosing(x: number): number {
  "worklet";
  return fit(x, 1, 5.65, 2.74, 8.38, 0.93, 3.29);
}

/** How far open the keyboard is, 0 to 1, at `height` when its full height is `open`. */
export function keyboardOpenness(height: number, open: number): number {
  "worklet";
  return open > 0 ? Math.min(1, Math.max(0, height / open)) : 0;
}

/**
 * The keyboard's height from the bottom of the window for a keyboard frame whose top edge is at
 * `screenY` (the event's `endCoordinates.screenY`): 0 when it is off screen.
 */
export function keyboardHeightAt(screenY: number, windowHeight: number): number {
  return Math.max(0, Math.round(windowHeight - screenY));
}
