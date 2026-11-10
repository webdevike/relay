/**
 * Pure math for `DotSlider` and `ThinkingPopover`. Each function is also called from a worklet,
 * so they take every input as a plain argument (no defaults, no module constants).
 */

/** The nearest step for a finger at `x`, where 0 is the first step's center and `width` the last's. */
export function stepAt(x: number, width: number, count: number): number {
  "worklet";
  if (count <= 1 || width <= 0) return 0;
  const raw = Math.round((x / width) * (count - 1));
  return Math.min(count - 1, Math.max(0, raw));
}

/** Where step `index` sits, from the first step's center (0) to the last's (`width`). */
export function stepX(index: number, width: number, count: number): number {
  "worklet";
  if (count <= 1) return 0;
  return (index / (count - 1)) * width;
}

/** Left edge of a card of `cardWidth` aligned to `anchorX`, kept `margin` inside a window of `windowWidth`. */
export function popoverLeft(anchorX: number, cardWidth: number, windowWidth: number, margin: number): number {
  const max = windowWidth - margin - cardWidth;
  return Math.max(margin, Math.min(anchorX, max));
}

/** Card width: the window minus its margins, capped at `cap`. */
export function popoverWidth(windowWidth: number, margin: number, cap: number): number {
  return Math.max(0, Math.min(windowWidth - 2 * margin, cap));
}
