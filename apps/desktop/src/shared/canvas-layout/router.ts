/**
 * Orthogonal link routing around cards. First a handful of designed shapes (L, Z through the
 * widest free gutter, U), then an A* search over the sparse grid that the cards' edges span, so
 * a route exists whenever any orthogonal path between the cards exists. Every route leaves its
 * source side outward, enters its target side inward, and never runs through a card.
 */
import type { Box } from './types'
import {
  bottom,
  isOrthogonal,
  oppositeSide,
  right,
  routeCrossesCards,
  routeLength,
  sideCenter,
  sideNormal,
  simplifyRoute,
  travelSide,
  unionBox,
  type Point,
  type Side,
} from './geometry'

const SIDES: readonly Side[] = ['right', 'bottom', 'left', 'top']
/** Cost of a bend in px of length: few bends beat a slightly shorter line. */
const BEND = 40
/** Cost of leaving or entering by a side other than the preferred one. */
const OFF_SIDE = 1500

export interface RouteEnd {
  box: Box
  /** The side preferred; the others cost OFF_SIDE (when `only` is false). */
  side: Side
  /** Exact attach point on `side` (default its middle). */
  at?: Point | undefined
  /** Only `side` may be used. */
  only?: boolean | undefined
  /** Leave `side` this far out before turning (to reach a gutter); tried before the default. */
  reach?: number | undefined
}

export interface RouteRequest {
  source: RouteEnd
  target: RouteEnd
  /** Other cards the route must not cross. */
  obstacles: Box[]
  /** Boxes (cards and frames) whose free gaps make the preferred gutters. */
  bands: Box[]
  /** The route may not run through its own source and target cards either. */
  avoidEnds: boolean
  /** Distance kept from cards, px. */
  clearance: number
}

function endPoint(end: RouteEnd, side: Side): Point {
  return side === end.side && end.at ? end.at : sideCenter(end.box, side)
}

/** Whether `route` is a well formed link between `src` and `tgt` on the given sides. */
export function routeIsClean(
  route: Point[],
  src: Box,
  tgt: Box,
  obstacles: Box[],
  avoidEnds: boolean,
): boolean {
  if (route.length < 2 || !isOrthogonal(route)) return false
  for (let i = 2; i < route.length; i++) {
    const a = travelSide(route[i - 2]!, route[i - 1]!)
    const b = travelSide(route[i - 1]!, route[i]!)
    if (!a || !b || b === oppositeSide(a)) return false
  }
  if (routeCrossesCards(route, obstacles)) return false
  if (avoidEnds && routeCrossesCards(route, [src, tgt])) return false
  return true
}

/** Middles of the stretches of [lo, hi] no box covers, widest first, then the plain middle. */
function gutters(lo: number, hi: number, covers: Array<[number, number]>): number[] {
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  const out: Array<[number, number]> = []
  if (b - a > 0) {
    const spans = covers
      .map(([s, e]) => [Math.max(s, a), Math.min(e, b)] as [number, number])
      .filter(([s, e]) => e > s)
      .sort((p, q) => p[0] - q[0])
    let at = a
    for (const [s, e] of spans) {
      if (s > at) out.push([at, s])
      at = Math.max(at, e)
    }
    if (b > at) out.push([at, b])
  }
  const mids = out
    .filter(([s, e]) => e - s >= 8)
    .sort((p, q) => q[1] - q[0] - (p[1] - p[0]) || p[0] - q[0])
    .map(([s, e]) => (s + e) / 2)
  mids.push((a + b) / 2)
  return mids
}

/** Shape tiers, most wanted first: both ends out to their reach, one, then neither. */
function candidates(req: RouteRequest, sSide: Side, tSide: Side, stub: number): Point[][][] {
  const reach = (end: RouteEnd) => [...(end.reach && end.reach > stub ? [end.reach] : []), stub]
  const tiers: Point[][][] = []
  for (const a of reach(req.source))
    for (const b of reach(req.target)) tiers.push(shapes(req, sSide, tSide, a, b))
  return tiers
}

function shapes(
  req: RouteRequest,
  sSide: Side,
  tSide: Side,
  sStub: number,
  tStub: number,
): Point[][] {
  const P = endPoint(req.source, sSide)
  const Q = endPoint(req.target, tSide)
  const ns = sideNormal(sSide)
  const nt = sideNormal(tSide)
  const P1 = { x: P.x + ns.x * sStub, y: P.y + ns.y * sStub }
  const Q1 = { x: Q.x + nt.x * tStub, y: Q.y + nt.y * tStub }
  const x0 = Math.min(P1.x, Q1.x)
  const x1 = Math.max(P1.x, Q1.x)
  const y0 = Math.min(P1.y, Q1.y)
  const y1 = Math.max(P1.y, Q1.y)
  const xCovers: Array<[number, number]> = []
  const yCovers: Array<[number, number]> = []
  for (const b of req.bands) {
    if (b.y < y1 && bottom(b) > y0) xCovers.push([b.x, right(b)])
    if (b.x < x1 && right(b) > x0) yCovers.push([b.y, bottom(b)])
  }
  const xs = gutters(P1.x, Q1.x, xCovers)
  const ys = gutters(P1.y, Q1.y, yCovers)
  // Same-facing sides (a U): go past the further of the two.
  if (sSide === tSide) {
    if (sSide === 'right') xs.unshift(Math.max(P1.x, Q1.x))
    if (sSide === 'left') xs.unshift(Math.min(P1.x, Q1.x))
    if (sSide === 'bottom') ys.unshift(Math.max(P1.y, Q1.y))
    if (sSide === 'top') ys.unshift(Math.min(P1.y, Q1.y))
  }
  const horizontalFirst = sSide === 'left' || sSide === 'right'
  const hvh = xs.map((mx) => [
    { x: mx, y: P1.y },
    { x: mx, y: Q1.y },
  ])
  const vhv = ys.map((my) => [
    { x: P1.x, y: my },
    { x: Q1.x, y: my },
  ])
  // Ties go to the earlier shape: through a gutter's middle first, hugging a card last.
  const mids = horizontalFirst ? [...hvh, ...vhv] : [...vhv, ...hvh]
  mids.push([{ x: Q1.x, y: P1.y }], [{ x: P1.x, y: Q1.y }])
  // A shape that doubles back over a stub (cleaned up into a shorter one) does not reach.
  const seg = (a: Point, b: Point) => Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
  return mids
    .map((m) => simplifyRoute([P, P1, ...m, Q1, Q]))
    .filter(
      (r) =>
        r.length >= 2 &&
        seg(r[0]!, r[1]!) >= sStub &&
        seg(r[r.length - 2]!, r[r.length - 1]!) >= tStub,
    )
}

function score(route: Point[]): number {
  return routeLength(route) + (route.length - 2) * BEND
}

/**
 * First and last segments run out of the source side and into the target side, each at least
 * 4 px long (a shorter one is a hidden spike, or vanishes when rounded).
 */
function onSides(route: Point[], sSide: Side, tSide: Side): boolean {
  const n = route.length
  if (n < 2) return false
  const a = route[0]!
  const b = route[1]!
  const y = route[n - 2]!
  const z = route[n - 1]!
  return (
    travelSide(a, b) === sSide &&
    travelSide(y, z) === oppositeSide(tSide) &&
    Math.abs(b.x - a.x) + Math.abs(b.y - a.y) >= 4 &&
    Math.abs(z.x - y.x) + Math.abs(z.y - y.y) >= 4
  )
}

class Heap {
  private f: number[] = []
  private s: number[] = []
  private seq: number[] = []
  private n = 0
  get size(): number {
    return this.f.length
  }
  push(f: number, state: number): void {
    const fs = this.f
    const ss = this.s
    const qs = this.seq
    fs.push(f)
    ss.push(state)
    qs.push(this.n++)
    let i = fs.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (fs[p]! < fs[i]! || (fs[p] === fs[i] && qs[p]! < qs[i]!)) break
      ;[fs[p], fs[i]] = [fs[i]!, fs[p]!]
      ;[ss[p], ss[i]] = [ss[i]!, ss[p]!]
      ;[qs[p], qs[i]] = [qs[i]!, qs[p]!]
      i = p
    }
  }
  pop(): [number, number] {
    const fs = this.f
    const ss = this.s
    const qs = this.seq
    const top: [number, number] = [fs[0]!, ss[0]!]
    const lf = fs.pop()!
    const ls = ss.pop()!
    const lq = qs.pop()!
    if (fs.length > 0) {
      fs[0] = lf
      ss[0] = ls
      qs[0] = lq
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        const less = (a: number, b: number) =>
          fs[a]! < fs[b]! || (fs[a] === fs[b] && qs[a]! < qs[b]!)
        if (l < fs.length && less(l, m)) m = l
        if (r < fs.length && less(r, m)) m = r
        if (m === i) break
        ;[fs[m], fs[i]] = [fs[i]!, fs[m]!]
        ;[ss[m], ss[i]] = [ss[i]!, ss[m]!]
        ;[qs[m], qs[i]] = [qs[i]!, qs[m]!]
        i = m
      }
    }
    return top
  }
}

/** Index of the first value >= v in sorted `a`. */
function lowerBound(a: number[], v: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (a[m]! < v) lo = m + 1
    else hi = m
  }
  return lo
}

function sortedUnique(values: number[]): number[] {
  const s = [...new Set(values)].sort((a, b) => a - b)
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    out.push(s[i]!)
    if (i + 1 < s.length && s[i + 1]! - s[i]! > 2) out.push((s[i]! + s[i + 1]!) / 2)
  }
  return out
}

/** Direction index: 0 +x, 1 +y, 2 -x, 3 -y. */
const DIR: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 }
const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]

/**
 * A* over the grid of obstacle edges (grown by `clearance`), stub ends and their midpoints,
 * limited to `area`. Penalizes bends and off-preference sides. Null when no path exists.
 */
function search(req: RouteRequest, clearance: number, area: Box): Point[] | null {
  const c = clearance
  const inflated: Box[] = []
  const grow = (b: Box) => ({ x: b.x - c, y: b.y - c, w: b.w + 2 * c, h: b.h + 2 * c })
  for (const b of req.obstacles) inflated.push(grow(b))
  if (req.avoidEnds) inflated.push(grow(req.source.box), grow(req.target.box))
  const ax1 = right(area)
  const ay1 = bottom(area)
  const obs = inflated.filter(
    (b) => b.x < ax1 && right(b) > area.x && b.y < ay1 && bottom(b) > area.y,
  )

  type End = { side: Side; at: Point; stub: Point; penalty: number }
  const ends = (end: RouteEnd): End[] =>
    (end.only ? [end.side] : SIDES).map((side) => {
      const at = endPoint(end, side)
      const n = sideNormal(side)
      return {
        side,
        at,
        stub: { x: at.x + n.x * c, y: at.y + n.y * c },
        penalty: side === end.side ? 0 : OFF_SIDE,
      }
    })
  const starts = ends(req.source)
  const goals = ends(req.target)

  const xv: number[] = [area.x, ax1]
  const yv: number[] = [area.y, ay1]
  for (const b of obs) {
    xv.push(b.x, right(b))
    yv.push(b.y, bottom(b))
  }
  for (const e of [...starts, ...goals]) {
    xv.push(e.stub.x)
    yv.push(e.stub.y)
  }
  const xs = sortedUnique(xv.filter((x) => x >= area.x && x <= ax1))
  const ys = sortedUnique(yv.filter((y) => y >= area.y && y <= ay1))
  const nx = xs.length
  const ny = ys.length
  const blockedPt = new Uint8Array(nx * ny)
  const blockedH = new Uint8Array(nx * ny) // segment (i,j)-(i+1,j)
  const blockedV = new Uint8Array(nx * ny) // segment (i,j)-(i,j+1)
  for (const b of obs) {
    const L = b.x
    const R = right(b)
    const T = b.y
    const B = bottom(b)
    const i0 = lowerBound(xs, L)
    const j0 = lowerBound(ys, T)
    for (let j = j0; j < ny && ys[j]! <= B; j++) {
      const yIn = ys[j]! > T && ys[j]! < B
      for (let i = i0; i < nx && xs[i]! <= R; i++) {
        const xIn = xs[i]! > L && xs[i]! < R
        const k = j * nx + i
        if (xIn && yIn) blockedPt[k] = 1
        if (yIn && i + 1 < nx && xs[i + 1]! <= R) blockedH[k] = 1
        if (xIn && j + 1 < ny && ys[j + 1]! <= B) blockedV[k] = 1
      }
    }
  }
  const idx = (p: Point) => {
    const i = lowerBound(xs, p.x)
    const j = lowerBound(ys, p.y)
    return xs[i] === p.x && ys[j] === p.y ? j * nx + i : -1
  }
  const states = nx * ny * 4
  const g = new Float64Array(states).fill(Infinity)
  const prev = new Int32Array(states).fill(-1)
  const heap = new Heap()
  const goalAt = new Map<number, End[]>()
  for (const e of goals) {
    const k = idx(e.stub)
    if (k < 0 || blockedPt[k]) continue
    goalAt.set(k, [...(goalAt.get(k) ?? []), e])
  }
  if (goalAt.size === 0) return null
  const h = (k: number) => {
    const x = xs[k % nx]!
    const y = ys[Math.floor(k / nx)]!
    let best = Infinity
    for (const e of goals) best = Math.min(best, Math.abs(e.stub.x - x) + Math.abs(e.stub.y - y))
    return best
  }
  const startOf = new Map<number, End>()
  for (const e of starts) {
    const k = idx(e.stub)
    if (k < 0 || blockedPt[k]) continue
    const s = k * 4 + DIR[e.side]
    const cost = e.penalty + c
    if (cost < g[s]!) {
      g[s] = cost
      startOf.set(s, e)
      heap.push(cost + h(k), s)
    }
  }
  // Final states are encoded past the grid: states + goal list position.
  const finals: Array<{ from: number; end: End }> = []
  let done = -1
  while (heap.size > 0) {
    const [f, s] = heap.pop()
    if (s >= states) {
      done = s - states
      break
    }
    const k = s >> 2
    const d = s & 3
    const gs = g[s]!
    if (f - h(k) > gs + 1e-9) continue
    const here = goalAt.get(k)
    if (here) {
      for (const e of here) {
        const din = (DIR[e.side] + 2) & 3
        if (d === DIR[e.side]) continue
        const cost = gs + (d === din ? 0 : BEND) + e.penalty + c
        finals.push({ from: s, end: e })
        heap.push(cost, states + finals.length - 1)
      }
    }
    const i = k % nx
    const j = (k - i) / nx
    for (let nd = 0; nd < 4; nd++) {
      if (nd === ((d + 2) & 3)) continue
      const ni = i + DX[nd]!
      const nj = j + DY[nd]!
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
      const nk = nj * nx + ni
      if (blockedPt[nk]) continue
      if (nd === 0 && blockedH[k]) continue
      if (nd === 2 && blockedH[nk]) continue
      if (nd === 1 && blockedV[k]) continue
      if (nd === 3 && blockedV[nk]) continue
      const len = Math.abs(xs[ni]! - xs[i]!) + Math.abs(ys[nj]! - ys[j]!)
      const ng = gs + len + (nd === d ? 0 : BEND)
      const ns = nk * 4 + nd
      if (ng < g[ns]! - 1e-9) {
        g[ns] = ng
        prev[ns] = s
        heap.push(ng + h(nk), ns)
      }
    }
  }
  if (done < 0) return null
  const fin = finals[done]!
  const pts: Point[] = [fin.end.at]
  let s = fin.from
  for (;;) {
    const k = s >> 2
    pts.push({ x: xs[k % nx]!, y: ys[Math.floor(k / nx)]! })
    const p = prev[s]!
    if (p < 0) break
    s = p
  }
  const start = startOf.get(s)
  if (!start) return null
  pts.push(start.at)
  return simplifyRoute(pts.reverse())
}

/**
 * The route for one link: the best clean designed shape on the preferred sides, else the A*
 * route (near the two cards first, then over the whole board, then with less clearance). Null
 * when the cards are walled in.
 */
export function routeLink(req: RouteRequest): Point[] | null {
  const S = req.source
  const T = req.target
  const stub = Math.max(4, req.clearance)
  const clean = (r: Point[], sSide: Side, tSide: Side) =>
    onSides(r, sSide, tSide) && routeIsClean(r, S.box, T.box, req.obstacles, req.avoidEnds)
  // A designed shape also keeps half the clearance from other cards (A* keeps all of it).
  const margin = -Math.max(2, req.clearance / 2)
  for (const tier of candidates(req, S.side, T.side, stub)) {
    let best: Point[] | null = null
    for (const r of tier)
      if (
        clean(r, S.side, T.side) &&
        !routeCrossesCards(r, req.obstacles, margin) &&
        (!best || score(r) < score(best))
      )
        best = r
    if (best) return best
  }
  const all = unionBox([S.box, T.box, ...req.obstacles])!
  const pair = unionBox([S.box, T.box])!
  for (const c of [req.clearance, Math.max(4, req.clearance / 2), 4]) {
    const m = c * 4 + 40
    const near = Math.max(240, Math.max(pair.w, pair.h) / 2)
    const areas = [
      { x: pair.x - near, y: pair.y - near, w: pair.w + 2 * near, h: pair.h + 2 * near },
      { x: all.x - m, y: all.y - m, w: all.w + 2 * m, h: all.h + 2 * m },
    ]
    for (const area of areas) {
      const r = search(req, c, area)
      if (!r) continue
      const sSide = travelSide(r[0]!, r[1]!)
      const tSide = travelSide(r[r.length - 2]!, r[r.length - 1]!)
      if (sSide && tSide && clean(r, sSide, oppositeSide(tSide))) return r
    }
  }
  return null
}

/**
 * A route for cards no clean route reaches (walled in by overlapping cards): the shortest
 * designed shape on the preferred sides, crossings and all.
 */
export function elbowLink(req: RouteRequest): Point[] {
  const S = req.source
  const T = req.target
  const stub = Math.max(4, req.clearance)
  let best: Point[] | null = null
  for (const tier of candidates(req, S.side, T.side, stub))
    for (const r of tier)
      if (onSides(r, S.side, T.side) && (!best || score(r) < score(best))) best = r
  if (best) return best
  const P = endPoint(S, S.side)
  const Q = endPoint(T, T.side)
  const r = simplifyRoute([P, { x: P.x, y: Q.y }, Q])
  return r.length >= 2 ? r : [P, Q]
}
