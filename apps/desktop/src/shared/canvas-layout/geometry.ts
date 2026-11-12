/**
 * Pure box and polyline geometry for the layout engine: overlap and crossing tests, route
 * clean up, and the align/distribute commands. Board units, absolute top lefts.
 */
import type { AlignTo, Box } from './types'

export type Point = { x: number; y: number }
export type Side = 'left' | 'right' | 'top' | 'bottom'

export const right = (b: Box): number => b.x + b.w
export const bottom = (b: Box): number => b.y + b.h
export const centerX = (b: Box): number => b.x + b.w / 2
export const centerY = (b: Box): number => b.y + b.h / 2

/** Whether two boxes share area (touching edges do not count) once `a` is grown by `gap`. */
export function boxesOverlap(a: Box, b: Box, gap = 0): boolean {
  return (
    a.x - gap < right(b) && b.x < right(a) + gap && a.y - gap < bottom(b) && b.y < bottom(a) + gap
  )
}

/** The smallest box around every box given (null for none). */
export function unionBox(boxes: Iterable<Box>): Box | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, right(b))
    y1 = Math.max(y1, bottom(b))
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Outward unit vector of a card side. */
export function sideNormal(side: Side): Point {
  switch (side) {
    case 'left':
      return { x: -1, y: 0 }
    case 'right':
      return { x: 1, y: 0 }
    case 'top':
      return { x: 0, y: -1 }
    case 'bottom':
      return { x: 0, y: 1 }
  }
}

export function oppositeSide(side: Side): Side {
  switch (side) {
    case 'left':
      return 'right'
    case 'right':
      return 'left'
    case 'top':
      return 'bottom'
    case 'bottom':
      return 'top'
  }
}

/** The middle of a card side. */
export function sideCenter(b: Box, side: Side): Point {
  switch (side) {
    case 'left':
      return { x: b.x, y: centerY(b) }
    case 'right':
      return { x: right(b), y: centerY(b) }
    case 'top':
      return { x: centerX(b), y: b.y }
    case 'bottom':
      return { x: centerX(b), y: bottom(b) }
  }
}

/** Liang-Barsky: whether segment p-q meets the closed box [x0,x1]x[y0,y1]. */
function segmentMeetsBox(p: Point, q: Point, x0: number, y0: number, x1: number, y1: number) {
  let t0 = 0
  let t1 = 1
  const dx = q.x - p.x
  const dy = q.y - p.y
  // Inequality den * t <= num: den < 0 bounds t from below (entering), den > 0 from above.
  const clip = (den: number, num: number): boolean => {
    if (den === 0) return num >= 0
    const t = num / den
    if (den < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  return clip(-dx, p.x - x0) && clip(dx, x1 - p.x) && clip(-dy, p.y - y0) && clip(dy, y1 - p.y)
}

/**
 * Whether polyline `route` runs through any of `rects`. A rect counts as crossed when a segment
 * meets it shrunk by `pad` on every side, so a line along a card's border or ending on it (a
 * link's own ends sit on its source's and target's sides) does not count; pass only the OTHER
 * cards (never the link's own source, target or the frames around them). Default pad 1 px.
 */
export function routeCrossesCards(route: Point[], rects: Box[], pad = 1): boolean {
  for (const r of rects) {
    const x0 = r.x + pad
    const y0 = r.y + pad
    const x1 = r.x + r.w - pad
    const y1 = r.y + r.h - pad
    if (x1 < x0 || y1 < y0) continue
    for (let i = 1; i < route.length; i++) {
      if (segmentMeetsBox(route[i - 1]!, route[i]!, x0, y0, x1, y1)) return true
    }
  }
  return false
}

/** Drops repeated points and the middle of straight runs. */
export function simplifyRoute(route: Point[]): Point[] {
  const out: Point[] = []
  for (const p of route) {
    const last = out[out.length - 1]
    if (last && last.x === p.x && last.y === p.y) continue
    if (out.length >= 2) {
      const a = out[out.length - 2]!
      const b = out[out.length - 1]!
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) out.pop()
    }
    out.push({ x: p.x, y: p.y })
  }
  return out
}

/** Whether every segment is horizontal or vertical. */
export function isOrthogonal(route: Point[]): boolean {
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!
    const b = route[i]!
    if (a.x !== b.x && a.y !== b.y) return false
  }
  return true
}

export function routeLength(route: Point[]): number {
  let n = 0
  for (let i = 1; i < route.length; i++)
    n += Math.abs(route[i]!.x - route[i - 1]!.x) + Math.abs(route[i]!.y - route[i - 1]!.y)
  return n
}

/** The side a segment from `a` to `b` leaves through (its direction of travel). */
export function travelSide(a: Point, b: Point): Side | null {
  if (a.x === b.x && a.y === b.y) return null
  if (a.y === b.y) return b.x > a.x ? 'right' : 'left'
  if (a.x === b.x) return b.y > a.y ? 'bottom' : 'top'
  return null
}

/** Which side of `b` point `p` sits on (within `tol`), else null. */
export function sideOfPoint(b: Box, p: Point, tol = 1): Side | null {
  const inX = p.x >= b.x - tol && p.x <= right(b) + tol
  const inY = p.y >= b.y - tol && p.y <= bottom(b) + tol
  if (inY && Math.abs(p.x - b.x) <= tol) return 'left'
  if (inY && Math.abs(p.x - right(b)) <= tol) return 'right'
  if (inX && Math.abs(p.y - b.y) <= tol) return 'top'
  if (inX && Math.abs(p.y - bottom(b)) <= tol) return 'bottom'
  return null
}

function known(boxes: ReadonlyMap<string, Box>, ids: readonly string[]): Array<[string, Box]> {
  const seen = new Set<string>()
  const out: Array<[string, Box]> = []
  for (const id of ids) {
    const b = boxes.get(id)
    if (b && !seen.has(id)) {
      seen.add(id)
      out.push([id, b])
    }
  }
  return out
}

/**
 * Lines cards up on one edge or center of their joint bounds (`center` horizontal centers,
 * `middle` vertical ones). Answers only the cards whose top left changes, rounded.
 */
export function alignNodes(
  boxes: ReadonlyMap<string, Box>,
  ids: readonly string[],
  to: AlignTo,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  const items = known(boxes, ids)
  const all = unionBox(items.map(([, b]) => b))
  if (items.length < 2 || !all) return out
  for (const [id, b] of items) {
    let x = b.x
    let y = b.y
    switch (to) {
      case 'left':
        x = all.x
        break
      case 'right':
        x = right(all) - b.w
        break
      case 'center':
        x = centerX(all) - b.w / 2
        break
      case 'top':
        y = all.y
        break
      case 'bottom':
        y = bottom(all) - b.h
        break
      case 'middle':
        y = centerY(all) - b.h / 2
        break
    }
    x = Math.round(x)
    y = Math.round(y)
    if (x !== b.x || y !== b.y) out.set(id, { x, y })
  }
  return out
}

/**
 * Spaces cards evenly along an axis, in their order on it. Without `gap` the two outermost
 * stay and the gaps between neighbours become equal (three cards or more); with `gap` they line
 * up from the first one that far apart. Answers only the cards that move, rounded.
 */
export function distributeNodes(
  boxes: ReadonlyMap<string, Box>,
  ids: readonly string[],
  axis: 'horizontal' | 'vertical',
  gap?: number,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  const h = axis === 'horizontal'
  const pos = (b: Box) => (h ? b.x : b.y)
  const len = (b: Box) => (h ? b.w : b.h)
  const items = known(boxes, ids).map(([id, b], i) => ({ id, b, i }))
  items.sort((a, b) => pos(a.b) - pos(b.b) || (h ? a.b.y - b.b.y : a.b.x - b.b.x) || a.i - b.i)
  if (items.length < 2) return out
  let step: number
  if (gap === undefined || !Number.isFinite(gap)) {
    if (items.length < 3) return out
    const first = items[0]!.b
    const last = items[items.length - 1]!.b
    const span = pos(last) + len(last) - pos(first)
    const sum = items.reduce((s, it) => s + len(it.b), 0)
    step = (span - sum) / (items.length - 1)
  } else step = gap
  let at = pos(items[0]!.b)
  for (const { id, b } of items) {
    const v = Math.round(at)
    at += len(b) + step
    const x = h ? v : b.x
    const y = h ? b.y : v
    if (x !== b.x || y !== b.y) out.set(id, { x, y })
  }
  return out
}
