/**
 * Swipe arbitration for a `NestedPager` (a pager inside another sideways pager, like a widget
 * stack on a Home page), as iOS does for nested horizontal scrollers: a sideways swipe that starts
 * on the inner pager turns its pages until it would run past its first or last one, and that swipe
 * goes to the outer pager instead; a mostly vertical swipe goes to whatever scrolls vertically.
 * Pure worklets, so the gesture runs them on the UI thread and tests run them in Node. No default
 * parameters: a worklet's default that names a module constant is not captured and crashes.
 */

/** Points the finger travels before a swipe is decided. */
export const SWIPE_SLOP = 10;
/** Sideways speed, in points per second, that turns the page however short the drag. */
export const FLING_VELOCITY = 300;

/**
 * Who takes a swipe: `undecided` until it has travelled `slop`; `vertical` when it runs more up or
 * down than sideways; `inner` when the page it heads for exists; `outer` when it heads past the
 * first or last page.
 */
export type SwipeOwner = "undecided" | "vertical" | "inner" | "outer";

/** Owner of a swipe that has travelled `dx`, `dy` from where it started on page `page` of `count`. */
export function swipeOwner(page: number, count: number, dx: number, dy: number): SwipeOwner {
  "worklet";
  if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return "undecided";
  if (Math.abs(dy) >= Math.abs(dx)) return "vertical";
  // A finger moving left brings the next page in.
  const target = dx < 0 ? page + 1 : page - 1;
  return target >= 0 && target < count ? "inner" : "outer";
}

/**
 * Where the strip of pages sits (its x offset) while the finger is `dx` along: it follows the
 * finger, but no further than the neighbouring page and never past the first or last.
 */
export function dragOffset(page: number, count: number, dx: number, width: number): number {
  "worklet";
  const lowest = -Math.min(page + 1, Math.max(count - 1, 0)) * width;
  const highest = -Math.max(page - 1, 0) * width;
  // `|| 0` turns the first page's -0 into 0.
  return Math.min(highest, Math.max(lowest, -page * width + dx)) || 0;
}

/**
 * The page a released swipe settles on: a fling (`vx` past `FLING_VELOCITY`) turns toward the
 * fling's side of where the strip is, a slow release turns once the strip is more than half way,
 * and it never moves more than one page or past either end.
 */
export function settlePage(page: number, count: number, dx: number, vx: number, width: number): number {
  "worklet";
  if (count <= 1) return 0;
  if (width <= 0) return Math.min(page, count - 1);
  const at = -dragOffset(page, count, dx, width) / width;
  const target = Math.abs(vx) >= FLING_VELOCITY ? (vx < 0 ? Math.ceil(at) : Math.floor(at)) : Math.round(at);
  return Math.max(0, page - 1, Math.min(count - 1, page + 1, target));
}
