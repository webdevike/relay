/** Pure helpers for drawing a link along the polyline canvas.layout routed (no DOM). */

export interface RoutePoint {
  x: number
  y: number
}

/** How far a route's end may sit from the card's current anchor and still be drawn. */
export const ROUTE_TOLERANCE = 3

/** Whether the route still starts on `a` and ends on `b` (the cards have not moved since layout). */
export function routeMatches(
  route: readonly RoutePoint[],
  a: readonly [number, number],
  b: readonly [number, number],
  tolerance = ROUTE_TOLERANCE,
): boolean {
  const first = route[0]
  const last = route[route.length - 1]
  if (route.length < 2 || !first || !last) return false
  return (
    Math.hypot(first.x - a[0], first.y - a[1]) <= tolerance &&
    Math.hypot(last.x - b[0], last.y - b[1]) <= tolerance
  )
}

export interface SideBox {
  x: number
  y: number
  w: number
  h: number
  side: 'left' | 'right' | 'top' | 'bottom'
}

/** Whether `p` lies on the named side of the box (anywhere along it), within `tolerance`. */
function onSide(p: RoutePoint, s: SideBox, tolerance: number): boolean {
  const horizontal = s.side === 'left' || s.side === 'right'
  const far = s.side === 'right' ? s.x + s.w : s.side === 'bottom' ? s.y + s.h : 0
  const fixed = horizontal ? (s.side === 'left' ? s.x : far) : s.side === 'top' ? s.y : far
  const lo = horizontal ? s.y : s.x
  const hi = lo + (horizontal ? s.h : s.w)
  const across = horizontal ? p.y : p.x
  const along = horizontal ? p.x : p.y
  return (
    Math.abs(along - fixed) <= tolerance && across >= lo - tolerance && across <= hi + tolerance
  )
}

/** Whether the route still starts on the source's chosen side and ends on the target's (layout may attach anywhere along a side). */
export function routeEndsOnSides(
  route: readonly RoutePoint[],
  from: SideBox,
  to: SideBox,
  tolerance = ROUTE_TOLERANCE,
): boolean {
  const first = route[0]
  const last = route[route.length - 1]
  if (route.length < 2 || !first || !last) return false
  return onSide(first, from, tolerance) && onSide(last, to, tolerance)
}

/**
 * A filled triangle path whose tip is `tip`, pointing along `from` to `tip` (the last segment of
 * a link). `length` is tip to base, `width` the base. Empty when the two points coincide.
 */
export function arrowHead(from: RoutePoint, tip: RoutePoint, length = 9, width = 8): string {
  const d = Math.hypot(tip.x - from.x, tip.y - from.y)
  if (d === 0) return ''
  const ux = (tip.x - from.x) / d
  const uy = (tip.y - from.y) / d
  const bx = tip.x - ux * length
  const by = tip.y - uy * length
  const px = (-uy * width) / 2
  const py = (ux * width) / 2
  return `M ${fmt(tip.x)} ${fmt(tip.y)} L ${fmt(bx + px)} ${fmt(by + py)} L ${fmt(bx - px)} ${fmt(by - py)} Z`
}

/** The route without consecutive duplicate points. */
function dedupe(route: readonly RoutePoint[]): RoutePoint[] {
  return route.filter((p, i) => i === 0 || p.x !== route[i - 1]!.x || p.y !== route[i - 1]!.y)
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100)

/** An SVG path along the polyline with each corner rounded by up to `radius` (quadratic). */
export function roundedPath(route: readonly RoutePoint[], radius = 10): string {
  const pts = dedupe(route)
  const first = pts[0]
  if (!first) return ''
  let d = `M ${fmt(first.x)} ${fmt(first.y)}`
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!
    const next = pts[i + 1]
    if (!next) {
      d += ` L ${fmt(p.x)} ${fmt(p.y)}`
      break
    }
    const prev = pts[i - 1]!
    const d1 = Math.hypot(p.x - prev.x, p.y - prev.y)
    const d2 = Math.hypot(next.x - p.x, next.y - p.y)
    const r = Math.min(radius, d1 / 2, d2 / 2)
    const sx = p.x - ((p.x - prev.x) / d1) * r
    const sy = p.y - ((p.y - prev.y) / d1) * r
    const ex = p.x + ((next.x - p.x) / d2) * r
    const ey = p.y + ((next.y - p.y) / d2) * r
    d += ` L ${fmt(sx)} ${fmt(sy)} Q ${fmt(p.x)} ${fmt(p.y)} ${fmt(ex)} ${fmt(ey)}`
  }
  return d
}

/** The middle of the route's longest segment, where the label pill sits. */
export function longestSegmentMid(route: readonly RoutePoint[]): [number, number] {
  const pts = dedupe(route)
  let best = -1
  let mid: [number, number] = [pts[0]?.x ?? 0, pts[0]?.y ?? 0]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len > best) {
      best = len
      mid = [(a.x + b.x) / 2, (a.y + b.y) / 2]
    }
  }
  return mid
}
