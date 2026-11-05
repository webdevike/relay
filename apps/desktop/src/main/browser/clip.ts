export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const right = (r: Rect): number => r.x + r.width
const bottom = (r: Rect): number => r.y + r.height

/**
 * `rect` with `hole` cut out of one side. A native view is one rectangle and cannot have a hole,
 * so the cut takes the whole band on the side that costs the least area: a toast in the top-right
 * corner of a pane moves the pane's top edge below it. A zero-size rect when nothing is left.
 */
function cutOne(rect: Rect, hole: Rect): Rect {
  const options: Rect[] = [
    { ...rect, y: bottom(hole), height: bottom(rect) - bottom(hole) }, // top band goes
    { ...rect, height: hole.y - rect.y }, // bottom band goes
    { ...rect, x: right(hole), width: right(rect) - right(hole) }, // left band goes
    { ...rect, width: hole.x - rect.x }, // right band goes
  ]
  let best: Rect | null = null
  for (const o of options) {
    if (o.width <= 0 || o.height <= 0) continue
    if (!best || o.width * o.height > best.width * best.height) best = o
  }
  return best ?? { ...rect, width: 0, height: 0 }
}

/**
 * The rect a native view may fill so it never covers any of `holes` (overlays drawn by the shell
 * page, such as toasts, which a native view would otherwise paint over). Width and height 0 when
 * the holes swallow it; the caller hides the view then.
 */
export function clipAround(rect: Rect, holes: readonly Rect[]): Rect {
  let out = rect
  for (const hole of holes) {
    if (out.width <= 0 || out.height <= 0) break
    const overlaps =
      out.x < right(hole) && hole.x < right(out) && out.y < bottom(hole) && hole.y < bottom(out)
    if (overlaps) out = cutOne(out, hole)
  }
  return out
}
