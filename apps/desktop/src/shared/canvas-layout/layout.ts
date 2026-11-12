/**
 * layoutBoard: places a board's cards and routes its links (see ./index.ts for the rules).
 *
 * Bottom up: each frame's children are laid out first (a lane's steps in one numbered row,
 * ordinary frames by the board's algorithm) and the frame becomes one block sized to fit them;
 * then its level is arranged (lanes stacked with loose cards beside them, else ELK
 * layered/radial/mrtree or the grid). The moved set starts at the top left of where it was, then
 * slides along the flow past cards that keep their place. Links get their level's own route (a
 * lane row's straight links and arcs, ELK's, a loop under the row) when it is still clean, a
 * drop through the gutter between lanes, else one from ./router.
 */
import type {
  Box,
  LaidEdge,
  LayoutAlgorithm,
  LayoutDirection,
  LayoutEdge,
  LayoutNode,
  LayoutOptions,
  LayoutResult,
} from './types'
import { elkLayered, elkTree, type Link } from './elk'
import { elbowLink, routeIsClean, routeLink } from './router'
import {
  bottom,
  boxesOverlap,
  centerX,
  centerY,
  oppositeSide,
  right,
  routeCrossesCards,
  sideCenter,
  simplifyRoute,
  travelSide,
  unionBox,
  type Point,
  type Side,
} from './geometry'

/** A frame's padding around its children. */
export const FRAME_PAD = 16
/** The title band on top of an ordinary frame (children start under it plus FRAME_PAD). */
export const FRAME_HEADER = 36
/** The heading band on top of a lane (children start under it plus FRAME_PAD). */
export const LANE_HEADER = 44
/** Narrowest frame, wide enough for a short title. */
export const FRAME_MIN_W = 200
/** Steps in one lane row before it wraps to the next. */
export const LANE_ROW_MAX = 6
/** A link label pill: 6.5 px per character plus padding, PILL_H tall. */
const PILL_H = 24
const pillWidth = (label: string | undefined): number => (label ? label.length * 6.5 + 32 : 0)
/** A lane row's arcs run in tracks this far apart, the first PILL_H / 2 + 10 off the cards. */
const TRACK = 14
/** A card side with x and y swapped. */
const TRANSPOSED: Record<Side, Side> = {
  left: 'top',
  top: 'left',
  right: 'bottom',
  bottom: 'right',
}

type Size = { w: number; h: number }

interface Edge {
  id: string
  source: string
  target: string
  label: string | undefined
  /** The file's tone is `loop`. */
  toneLoop: boolean
  /** Points back against the flow: tone `loop`, a self link, a DFS back edge, or (in a lane row) a link to an earlier step. */
  loop: boolean
}

interface Ctx {
  spacing: number
  clearance: number
  columns: number | undefined
  node: Map<string, LayoutNode>
  index: Map<string, number>
  parent: Map<string, string>
  /** Moving children of each moving frame, in input order. */
  kids: Map<string, string[]>
  moving: Set<string>
  edges: Edge[]
  /**
   * Links a level laid out itself: `flow` (ELK, or straight between neighbours in a lane row),
   * `skip` (a lane row's forward arc over the row), `loop` (a return arc under the row) or
   * `drop` (a lane row's link on to the next row, through the gap between them).
   */
  kind: Map<string, 'flow' | 'skip' | 'loop' | 'drop'>
  /** A lane step's row in its lane, and the last step of each row. */
  rowOf: Map<string, number>
  rowEnds: Set<string>
}

/** One level laid out, relative to its own top left (0,0). */
interface Content {
  /** Top left of every member and everything inside them. */
  pos: Map<string, Point>
  frameSizes: Map<string, Size>
  routes: Map<string, Point[]>
  w: number
  h: number
}

interface LevelLink {
  e: Edge
  /** The members the link's ends sit in at this level. */
  a: string
  b: string
  /** Its ends are the members themselves. */
  direct: boolean
}

const finite = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Marks DFS back edges (from roots first, input order) as loops. */
function markLoops(edges: Edge[], ids: string[]): void {
  const out = new Map<string, Edge[]>()
  const indeg = new Map<string, number>()
  for (const id of ids) {
    out.set(id, [])
    indeg.set(id, 0)
  }
  for (const e of edges) {
    if (e.loop) continue
    out.get(e.source)!.push(e)
    indeg.set(e.target, indeg.get(e.target)! + 1)
  }
  const state = new Map<string, 1 | 2>()
  for (const root of [...ids.filter((id) => indeg.get(id) === 0), ...ids]) {
    if (state.has(root)) continue
    state.set(root, 1)
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }]
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      const list = out.get(top.id)!
      if (top.next >= list.length) {
        state.set(top.id, 2)
        stack.pop()
        continue
      }
      const e = list[top.next++]!
      const s = state.get(e.target)
      if (s === 1) e.loop = true
      else if (s === undefined) {
        state.set(e.target, 1)
        stack.push({ id: e.target, next: 0 })
      }
    }
  }
}

/** Kahn's order of `ids` by `pairs`, earliest input first; a cycle yields to input order. */
function topoOrder(
  ids: string[],
  pairs: Array<[string, string]>,
  index: Map<string, number>,
): string[] {
  const indeg = new Map(ids.map((id) => [id, 0]))
  const next = new Map(ids.map((id) => [id, [] as string[]]))
  for (const [a, b] of pairs) {
    next.get(a)!.push(b)
    indeg.set(b, indeg.get(b)! + 1)
  }
  const left = [...ids].sort((p, q) => index.get(p)! - index.get(q)!)
  const out: string[] = []
  while (left.length > 0) {
    const i = Math.max(
      0,
      left.findIndex((id) => indeg.get(id) === 0),
    )
    const id = left.splice(i, 1)[0]!
    out.push(id)
    for (const b of next.get(id)!) indeg.set(b, indeg.get(b)! - 1)
  }
  return out
}

/** Routes loop-back links between members of a layered level through the gutter under their row (right of their column for `down`). */
function loopRoutes(
  ctx: Ctx,
  members: string[],
  rel: Map<string, Point>,
  size: Map<string, Size>,
  loops: Edge[],
  direction: LayoutDirection,
  routes: Map<string, Point[]>,
): void {
  // Work as if the flow ran right (loops under the row); `down` is the same transposed.
  const t = direction === 'down'
  const tb = (b: Box): Box => (t ? { x: b.y, y: b.x, w: b.h, h: b.w } : b)
  const boxes = new Map(members.map((id) => [id, tb({ ...rel.get(id)!, ...size.get(id)! })]))
  const ends = new Map<string, Array<{ key: string; other: string }>>()
  for (const e of loops) {
    ctx.kind.set(e.id, 'loop')
    ends.set(e.source, [...(ends.get(e.source) ?? []), { key: `${e.id}\0s`, other: e.target }])
    ends.set(e.target, [...(ends.get(e.target) ?? []), { key: `${e.id}\0t`, other: e.source }])
  }
  // Spread each card's loop ends along its bottom so nested loops do not cross: ends going
  // left on the left, right on the right, the longer loop of each group nearer the middle.
  const port = new Map<string, number>()
  for (const [id, list] of ends) {
    const b = boxes.get(id)!
    const cx = centerX(b)
    const oc = (o: string) => centerX(boxes.get(o)!)
    list.sort(
      (p, q) =>
        (oc(p.other) < cx ? 0 : 1) - (oc(q.other) < cx ? 0 : 1) || oc(q.other) - oc(p.other),
    )
    list.forEach((it, k) => port.set(it.key, b.x + (b.w * (k + 1)) / (list.length + 1)))
  }
  const first = clamp(ctx.spacing / 2, 16, 32)
  const track = 14
  const span = (e: Edge) => Math.abs(port.get(`${e.id}\0s`)! - port.get(`${e.id}\0t`)!)
  const sorted = [...loops].sort(
    (a, b) => span(a) - span(b) || ctx.index.get(a.source)! - ctx.index.get(b.source)!,
  )
  const placed: Array<{ lo: number; hi: number; y: number }> = []
  for (const e of sorted) {
    const S = boxes.get(e.source)!
    const T = boxes.get(e.target)!
    const sx = port.get(`${e.id}\0s`)!
    const tx = port.get(`${e.id}\0t`)!
    const x0 = Math.min(S.x, T.x)
    const x1 = Math.max(right(S), right(T))
    let y = -Infinity
    for (const b of boxes.values()) if (b.x < x1 && right(b) > x0) y = Math.max(y, bottom(b))
    y += first
    const lo = Math.min(sx, tx)
    const hi = Math.max(sx, tx)
    for (const p of [...placed].sort((a, b) => a.y - b.y))
      if (p.lo <= hi + 4 && lo <= p.hi + 4 && Math.abs(p.y - y) < track) y = p.y + track
    const route = [
      { x: sx, y: bottom(S) },
      { x: sx, y },
      { x: tx, y },
      { x: tx, y: bottom(T) },
    ]
    const others = members
      .filter((id) => id !== e.source && id !== e.target)
      .map((id) => boxes.get(id)!)
    if (routeCrossesCards(route, others) || routeCrossesCards(route, [S, T])) continue
    placed.push({ lo, hi, y })
    routes.set(
      e.id,
      route.map((p) => (t ? { x: p.y, y: p.x } : p)),
    )
  }
}

/**
 * A lane's steps: one row in input order (more than LANE_ROW_MAX: as few rows as that allows,
 * evenly filled), top aligned (a column for `down`). Neighbours are `spacing` apart, wider
 * where a label must fit between them, and linked straight; a forward link that skips steps
 * arcs over the row (top to top), a link back (or tone `loop`) under it (bottom to bottom),
 * each in its own track so arcs nest without crossing. A forward link on to the next row drops
 * from under its step through the gap between the rows into its target's top. The tracks and
 * their label pills count toward the content, so the lane grows around them and no arc reaches
 * its heading. Other links between rows are left to the router.
 */
function arrangeRow(
  ctx: Ctx,
  members: string[],
  size: Map<string, Size>,
  level: LevelLink[],
  direction: LayoutDirection,
  rel: Map<string, Point>,
  routes: Map<string, Point[]>,
  extent: Box[],
): void {
  // Work as if the row ran right (arcs over and under it); `down` is the same transposed.
  const t = direction === 'down'
  const flip = (p: Point): Point => (t ? { x: p.y, y: p.x } : p)
  const along = (id: string) => (t ? size.get(id)!.h : size.get(id)!.w)
  const thick = (id: string) => (t ? size.get(id)!.w : size.get(id)!.h)
  // As few rows as LANE_ROW_MAX allows, as even as they go (7 steps: 4 and 3).
  const per = Math.ceil(members.length / Math.ceil(members.length / LANE_ROW_MAX))
  const rows: string[][] = []
  for (let i = 0; i < members.length; i += per) rows.push(members.slice(i, i + per))
  const at = new Map<string, number>()
  rows.forEach((row, r) => {
    row.forEach((id, i) => {
      at.set(id, i)
      ctx.rowOf.set(id, r)
    })
    ctx.rowEnds.add(row[row.length - 1]!)
  })
  type Arc = { e: Edge; a: string; b: string; above: boolean }
  const rowOf = (id: string) => ctx.rowOf.get(id)!
  const inRow = level.filter((l) => l.direct && rowOf(l.a) === rowOf(l.b))
  const straight = new Set<Edge>()
  const arcs: Arc[] = []
  for (const { e, a, b } of inRow) {
    const back = e.toneLoop || at.get(b)! < at.get(a)!
    e.loop = back
    if (back) arcs.push({ e, a, b, above: false })
    else if (at.get(b) === at.get(a)! + 1) straight.add(e)
    else arcs.push({ e, a, b, above: true })
  }
  // A forward link to the next row drops from under its step through the gap between the rows
  // and into its target from above.
  const drops = level.filter((l) => l.direct && !l.e.toneLoop && rowOf(l.b) === rowOf(l.a) + 1)
  for (const { e } of drops) {
    e.loop = false
    ctx.kind.set(e.id, 'drop')
  }
  // The widest label between two neighbours sets the gap after the first of them.
  const gapAfter = new Map<string, number>()
  for (const { e, a, b } of inRow) {
    if (Math.abs(at.get(a)! - at.get(b)!) !== 1 || !e.label) continue
    const first = at.get(a)! < at.get(b)! ? a : b
    const need = t ? PILL_H + 32 : pillWidth(e.label)
    gapAfter.set(first, Math.max(gapAfter.get(first) ?? 0, need))
  }
  const x = new Map<string, number>()
  for (const row of rows) {
    let run = 0
    for (const id of row) {
      x.set(id, run)
      run += along(id) + Math.max(ctx.spacing, gapAfter.get(id) ?? 0)
    }
  }
  const mid = (id: string) => x.get(id)! + along(id) / 2

  const port = new Map<string, number>()
  const top: number[] = []
  const bandEnd: number[] = []
  /** Where the gap before row r (holding the drops into it) ends. */
  const gapEnd: number[] = []
  let cursor = 0
  rows.forEach((row, r) => {
    const rowSet = new Set(row)
    const mine = arcs.filter((arc) => rowSet.has(arc.a))
    // Ends on each card side spread so nested arcs never cross: ends heading left on the left,
    // right on the right, the longer arc of each group further out.
    for (const above of [true, false]) {
      const ends = new Map<string, Array<{ key: string; other: string }>>()
      const add = (id: string, key: string, other: string) =>
        ends.set(id, [...(ends.get(id) ?? []), { key, other }])
      for (const { e, a, b } of mine.filter((arc) => arc.above === above)) {
        add(a, `${e.id}\0s`, b)
        add(b, `${e.id}\0t`, a)
      }
      for (const { e, a, b } of drops) {
        if (!above && rowSet.has(a)) add(a, `${e.id}\0s`, b)
        if (above && rowSet.has(b)) add(b, `${e.id}\0t`, a)
      }
      for (const [id, list] of ends) {
        const m = mid(id)
        list.sort(
          (p, q) =>
            (mid(p.other) < m ? 0 : 1) - (mid(q.other) < m ? 0 : 1) || mid(q.other) - mid(p.other),
        )
        list.forEach((it, k) =>
          port.set(it.key, Math.round(x.get(id)! + (along(id) * (k + 1)) / (list.length + 1))),
        )
      }
    }
    // Tracks: shortest arcs nearest the row, each in the first track free over its span.
    const track = new Map<Arc, number>()
    const band = { above: 0, below: 0 }
    const widest = { above: 0, below: 0 }
    const span = (arc: Arc): [number, number] => {
      const s = port.get(`${arc.e.id}\0s`)!
      const d = port.get(`${arc.e.id}\0t`)!
      return [Math.min(s, d), Math.max(s, d)]
    }
    for (const above of [true, false]) {
      const used: Array<Array<[number, number]>> = []
      const list = mine
        .filter((arc) => arc.above === above)
        .sort((p, q) => {
          const [p0, p1] = span(p)
          const [q0, q1] = span(q)
          return p1 - p0 - (q1 - q0) || p0 - q0 || ctx.index.get(p.a)! - ctx.index.get(q.a)!
        })
      const key = above ? 'above' : 'below'
      for (const arc of list) {
        const [lo, hi] = span(arc)
        let k = 0
        while (used[k]?.some(([l, h]) => l <= hi + 6 && lo <= h + 6)) k++
        ;(used[k] ??= []).push([lo, hi])
        track.set(arc, k)
        band[key] = Math.max(band[key], k + 1)
        widest[key] = Math.max(widest[key], pillWidth(arc.e.label))
      }
    }
    // A pill reaches PILL_H / 2 across its track (half its width for `down`, where the track
    // runs along the cards); the first track keeps it 10 px off them.
    const half = (key: 'above' | 'below') => (t ? Math.max(PILL_H, widest[key]) / 2 : PILL_H / 2)
    const first = { above: half('above') + 10, below: half('below') + 10 }
    const H = Math.max(...row.map(thick))
    // The gap before this row holds the drops from the row above, one track each.
    if (r > 0) {
      const into = drops.filter((l) => rowSet.has(l.b))
      const labelled = into.some((l) => l.e.label)
      cursor += Math.max(
        ctx.spacing,
        (into.length + 1) * TRACK,
        labelled ? (t ? Math.max(...into.map((l) => pillWidth(l.e.label))) : PILL_H) + 20 : 0,
      )
      gapEnd[r] = cursor
    }
    top[r] = cursor + (band.above ? half('above') + first.above + (band.above - 1) * TRACK : 0)
    for (const id of row) rel.set(id, flip({ x: x.get(id)!, y: top[r]! }))
    const lineY = top[r]! + Math.min(...row.map(thick)) / 2
    for (const { e, a, b } of inRow) {
      if (!rowSet.has(a) || !straight.has(e)) continue
      ctx.kind.set(e.id, 'flow')
      routes.set(e.id, [
        flip({ x: x.get(a)! + along(a), y: lineY }),
        flip({ x: x.get(b)!, y: lineY }),
      ])
    }
    for (const arc of mine) {
      const { e, a, b, above } = arc
      const k = track.get(arc)!
      const ty = above ? top[r]! - first.above - k * TRACK : top[r]! + H + first.below + k * TRACK
      const sx = port.get(`${e.id}\0s`)!
      const tx = port.get(`${e.id}\0t`)!
      const ay = above ? top[r]! : top[r]! + thick(a)
      const by = above ? top[r]! : top[r]! + thick(b)
      ctx.kind.set(e.id, above ? 'skip' : 'loop')
      routes.set(
        e.id,
        [
          { x: sx, y: ay },
          { x: sx, y: ty },
          { x: tx, y: ty },
          { x: tx, y: by },
        ].map(flip),
      )
      // Room for its label pill, centered on the track.
      const c = flip({ x: (sx + tx) / 2, y: ty })
      const w = Math.max(pillWidth(e.label), PILL_H)
      extent.push({ x: c.x - w / 2, y: c.y - PILL_H / 2, w, h: PILL_H })
    }
    bandEnd[r] = band.below
      ? top[r]! + H + first.below + (band.below - 1) * TRACK + half('below')
      : top[r]! + H
    cursor = bandEnd[r]!
  })
  // Each drop runs level through the gap under its source's row, in its own track.
  for (let r = 0; r + 1 < rows.length; r++) {
    const list = drops
      .filter((l) => rowOf(l.a) === r)
      .sort((p, q) => port.get(`${p.e.id}\0s`)! - port.get(`${q.e.id}\0s`)!)
    const gapTop = bandEnd[r]!
    const room = gapEnd[r + 1]! - gapTop
    list.forEach(({ e, a }, k) => {
      const gy = gapTop + (room * (k + 1)) / (list.length + 1)
      const sx = port.get(`${e.id}\0s`)!
      const tx = port.get(`${e.id}\0t`)!
      routes.set(
        e.id,
        [
          { x: sx, y: top[r]! + thick(a) },
          { x: sx, y: gy },
          { x: tx, y: gy },
          { x: tx, y: top[r + 1]! },
        ].map(flip),
      )
      if (e.label) {
        const c = flip({ x: (sx + tx) / 2, y: gy })
        const w = pillWidth(e.label)
        extent.push({ x: c.x - w / 2, y: c.y - PILL_H / 2, w, h: PILL_H })
      }
    })
  }
}

/**
 * Phase lanes stacked in dependency order, equally long. A topic linked to no lane card heads
 * them (above, from their left edge). Loose cards linked to nothing sit on a shelf under the
 * lanes (right of them for `down`) from their left edge, in input order, wrapping at the lanes'
 * length. Other loose cards go in a column right of the lanes (a row under them for `down`), in
 * the order of the lane card they link to, each level with it, then the rest in input order.
 */
function arrangeLanes(
  ctx: Ctx,
  members: string[],
  lanes: string[],
  size: Map<string, Size>,
  inner: Map<string, Content>,
  level: LevelLink[],
  direction: LayoutDirection,
  rel: Map<string, Point>,
): void {
  const rows = direction === 'right'
  const laneSet = new Set(lanes)
  const order = topoOrder(
    lanes,
    level.filter((l) => !l.e.loop && laneSet.has(l.a) && laneSet.has(l.b)).map((l) => [l.a, l.b]),
    ctx.index,
  )
  const long = Math.max(...lanes.map((id) => (rows ? size.get(id)!.w : size.get(id)!.h)))
  for (const id of lanes) {
    const s = size.get(id)!
    size.set(id, rows ? { w: long, h: s.h } : { w: s.w, h: long })
  }
  const gap = Math.round(ctx.spacing * 1.5)
  let at = 0
  for (const id of order) {
    rel.set(id, rows ? { x: 0, y: at } : { x: at, y: 0 })
    at += (rows ? size.get(id)!.h : size.get(id)!.w) + gap
  }
  // Where a lane card sits: across the lanes (their stacking axis), then along its lane.
  const spot = (lane: string, card: string): [number, number] | undefined => {
    const lp = rel.get(lane)!
    const q = card === lane ? { x: 0, y: 0 } : inner.get(lane)!.pos.get(card)
    if (!q) return undefined
    return rows ? [lp.y + q.y, lp.x + q.x] : [lp.x + q.x, lp.y + q.y]
  }
  const anchor = new Map<string, [number, number]>()
  for (const l of level) {
    const end =
      laneSet.has(l.b) && !laneSet.has(l.a)
        ? { id: l.a, s: spot(l.b, l.e.target) }
        : laneSet.has(l.a) && !laneSet.has(l.b)
          ? { id: l.b, s: spot(l.a, l.e.source) }
          : undefined
    if (!end?.s) continue
    const was = anchor.get(end.id)
    if (!was || end.s[0] < was[0] || (end.s[0] === was[0] && end.s[1] < was[1]))
      anchor.set(end.id, end.s)
  }
  const idx = (id: string) => ctx.index.get(id)!
  const loose = members.filter((id) => !laneSet.has(id))
  const header = loose.filter((id) => ctx.node.get(id)!.topic === true && !anchor.has(id))
  const headH = Math.max(0, ...header.map((id) => size.get(id)!.h))
  let hx = 0
  for (const id of header) {
    rel.set(id, { x: hx, y: -gap - headH })
    hx += size.get(id)!.w + ctx.spacing
  }
  const linked = new Set(level.flatMap((l) => [l.a, l.b]))
  const shelf = loose.filter((id) => !header.includes(id) && !linked.has(id))
  const side = loose.filter((id) => !header.includes(id) && linked.has(id))
  const queue = [
    ...side
      .filter((id) => anchor.has(id))
      .sort((p, q) => {
        const [p0, p1] = anchor.get(p)!
        const [q0, q1] = anchor.get(q)!
        return p0 - q0 || p1 - q1 || idx(p) - idx(q)
      }),
    ...side.filter((id) => !anchor.has(id)),
  ]
  let cursor = -Infinity
  for (const id of queue) {
    const v = Math.max(anchor.get(id)?.[0] ?? (cursor === -Infinity ? 0 : cursor), cursor)
    rel.set(id, rows ? { x: long + gap, y: v } : { x: v, y: long + gap })
    cursor = v + (rows ? size.get(id)!.h : size.get(id)!.w) + ctx.spacing
  }
  // The shelf, in lane terms: `u` along the lanes' length, `v` across them past the last lane.
  const uLen = (id: string) => (rows ? size.get(id)!.w : size.get(id)!.h)
  const vLen = (id: string) => (rows ? size.get(id)!.h : size.get(id)!.w)
  const spots: Array<{ id: string; u: number; v: number }> = []
  let su = 0
  let sv = 0
  let rowV = 0
  for (const id of shelf) {
    if (su > 0 && su + uLen(id) > long) {
      sv += rowV + ctx.spacing
      su = 0
      rowV = 0
    }
    spots.push({ id, u: su, v: sv })
    su += uLen(id) + ctx.spacing
    rowV = Math.max(rowV, vLen(id))
  }
  // A card longer than the lanes would reach the side cards: then the shelf goes past them too.
  let v0 = at
  if (spots.some((s) => s.u + uLen(s.id) > long))
    for (const id of queue) {
      const p = rel.get(id)!
      v0 = Math.max(v0, (rows ? p.y : p.x) + vLen(id) + gap)
    }
  for (const s of spots) rel.set(s.id, rows ? { x: s.u, y: v0 + s.v } : { x: v0 + s.v, y: s.u })
}

/** A uniform grid in input order: columns as wide as their widest card, rows as tall as their tallest. */
function arrangeGrid(
  ctx: Ctx,
  members: string[],
  size: Map<string, Size>,
  direction: LayoutDirection,
  rel: Map<string, Point>,
): void {
  const n = members.length
  const cols = clamp(Math.round(ctx.columns ?? Math.ceil(Math.sqrt(n))), 1, n)
  const rowCount = Math.ceil(n / cols)
  const cell = (i: number) =>
    direction === 'down'
      ? { c: Math.floor(i / rowCount), r: i % rowCount }
      : { c: i % cols, r: Math.floor(i / cols) }
  const colW: number[] = []
  const rowH: number[] = []
  members.forEach((id, i) => {
    const { c, r } = cell(i)
    const s = size.get(id)!
    colW[c] = Math.max(colW[c] ?? 0, s.w)
    rowH[r] = Math.max(rowH[r] ?? 0, s.h)
  })
  const xs: number[] = []
  const ys: number[] = []
  colW.reduce((x, w, c) => ((xs[c] = x), x + w + ctx.spacing), 0)
  rowH.reduce((y, h, r) => ((ys[r] = y), y + h + ctx.spacing), 0)
  members.forEach((id, i) => {
    const { c, r } = cell(i)
    rel.set(id, { x: xs[c]!, y: ys[r]! })
  })
}

/** Scales a radial layout about its root until no two cards come within `gap`. */
function spreadOut(pos: Map<string, Point>, size: Map<string, Size>, root: string, gap: number) {
  const ids = [...pos.keys()]
  const rs = size.get(root)!
  const rc = { x: pos.get(root)!.x + rs.w / 2, y: pos.get(root)!.y + rs.h / 2 }
  let out = pos
  for (let k = 1, i = 0; i < 60; i++, k *= 1.15) {
    out = new Map(
      ids.map((id) => {
        const p = pos.get(id)!
        const s = size.get(id)!
        const cx = rc.x + (p.x + s.w / 2 - rc.x) * k
        const cy = rc.y + (p.y + s.h / 2 - rc.y) * k
        return [id, { x: cx - s.w / 2, y: cy - s.h / 2 }]
      }),
    )
    const boxes = ids.map((id) => ({ ...out.get(id)!, ...size.get(id)! }))
    let clear = true
    for (let a = 0; a < boxes.length && clear; a++)
      for (let b = a + 1; b < boxes.length; b++)
        if (boxesOverlap(boxes[a]!, boxes[b]!, gap)) {
          clear = false
          break
        }
    if (clear) break
  }
  return out
}

/** ELK radial or mrtree per connected group, from its topic (else its root, else its busiest card). */
async function arrangeTree(
  ctx: Ctx,
  members: string[],
  size: Map<string, Size>,
  level: LevelLink[],
  algorithm: 'radial' | 'mrtree',
  direction: LayoutDirection,
  rel: Map<string, Point>,
): Promise<void> {
  const idx = (id: string) => ctx.index.get(id)!
  const adj = new Map(members.map((id) => [id, [] as string[]]))
  const indeg = new Map(members.map((id) => [id, 0]))
  const outdeg = new Map(members.map((id) => [id, 0]))
  for (const l of level) {
    adj.get(l.a)!.push(l.b)
    adj.get(l.b)!.push(l.a)
    if (!l.e.loop) {
      indeg.set(l.b, indeg.get(l.b)! + 1)
      outdeg.set(l.a, outdeg.get(l.a)! + 1)
    }
  }
  for (const list of adj.values()) list.sort((p, q) => idx(p) - idx(q))
  const seen = new Set<string>()
  const groups: Array<{ pos: Map<string, Point>; box: Box }> = []
  for (const start of members) {
    if (seen.has(start)) continue
    const comp: string[] = []
    const q = [start]
    seen.add(start)
    while (q.length > 0) {
      const v = q.shift()!
      comp.push(v)
      for (const w of adj.get(v)!)
        if (!seen.has(w)) {
          seen.add(w)
          q.push(w)
        }
    }
    comp.sort((p, q2) => idx(p) - idx(q2))
    const best = (list: string[], score: (id: string) => number) =>
      list.reduce<string | undefined>(
        (m, id) => (m === undefined || score(id) > score(m) ? id : m),
        undefined,
      )
    const root =
      comp.find((id) => ctx.node.get(id)!.topic === true) ??
      best(
        comp.filter((id) => indeg.get(id) === 0),
        (id) => outdeg.get(id)!,
      ) ??
      best(comp, (id) => adj.get(id)!.length)!
    const links: Link[] = []
    const inTree = new Set([root])
    const bq = [root]
    while (bq.length > 0) {
      const v = bq.shift()!
      for (const w of adj.get(v)!)
        if (!inTree.has(w)) {
          inTree.add(w)
          bq.push(w)
          links.push({ id: `${links.length}`, source: v, target: w })
          // A tree link that points from parent to child leaves and enters on the flow sides.
          if (algorithm === 'mrtree')
            for (const l of level)
              if (l.direct && l.a === v && l.b === w && !l.e.loop) ctx.kind.set(l.e.id, 'flow')
        }
    }
    let pos =
      comp.length === 1
        ? new Map([[root, { x: 0, y: 0 }]])
        : await elkTree(
            comp.map((id) => ({ id, ...size.get(id)! })),
            links,
            algorithm,
            direction,
            ctx.spacing,
          )
    if (algorithm === 'radial' && comp.length > 1) pos = spreadOut(pos, size, root, ctx.spacing / 2)
    const box = unionBox(comp.map((id) => ({ ...pos.get(id)!, ...size.get(id)! })))!
    groups.push({ pos, box })
  }
  // Separate groups side by side (stacked for a tree growing right).
  const stack = algorithm === 'mrtree' && direction === 'right'
  let at = 0
  for (const g of groups) {
    for (const [id, p] of g.pos)
      rel.set(
        id,
        stack
          ? { x: p.x - g.box.x, y: p.y - g.box.y + at }
          : { x: p.x - g.box.x + at, y: p.y - g.box.y },
      )
    at += (stack ? g.box.h : g.box.w) + ctx.spacing * 2
  }
}

/**
 * Lays out `members` (one level: top level or one frame's children, `inLane` for a lane's
 * steps) and everything inside them.
 */
async function layoutMembers(
  ctx: Ctx,
  members: string[],
  algorithm: LayoutAlgorithm,
  direction: LayoutDirection,
  inLane = false,
): Promise<Content> {
  if (members.length === 0)
    return { pos: new Map(), frameSizes: new Map(), routes: new Map(), w: 0, h: 0 }
  const size = new Map<string, Size>()
  const inner = new Map<string, Content>()
  for (const id of members) {
    const n = ctx.node.get(id)!
    const kids = ctx.kids.get(id)
    if (!kids || kids.length === 0) {
      size.set(id, { w: n.w, h: n.h })
      continue
    }
    const lane = n.lane === true
    const c = await layoutMembers(ctx, kids, algorithm, direction, lane)
    const top = (lane ? LANE_HEADER : FRAME_HEADER) + FRAME_PAD
    const shift = (p: Point) => ({ x: p.x + FRAME_PAD, y: p.y + top })
    inner.set(id, {
      ...c,
      pos: new Map([...c.pos].map(([k, p]) => [k, shift(p)])),
      routes: new Map([...c.routes].map(([k, r]) => [k, r.map(shift)])),
    })
    size.set(id, {
      w: Math.max(Math.round(c.w + 2 * FRAME_PAD), FRAME_MIN_W),
      h: Math.round(c.h + top + FRAME_PAD),
    })
  }

  const memberSet = new Set(members)
  const lift = (id: string) => {
    if (!ctx.moving.has(id)) return undefined
    let cur: string | undefined = id
    while (cur !== undefined && !memberSet.has(cur)) cur = ctx.parent.get(cur)
    return cur
  }
  const level: LevelLink[] = []
  for (const e of ctx.edges) {
    const a = lift(e.source)
    const b = lift(e.target)
    if (a === undefined || b === undefined || a === b) continue
    level.push({ e, a, b, direct: a === e.source && b === e.target })
  }

  const rel = new Map<string, Point>()
  const routes = new Map<string, Point[]>()
  // What the level takes besides its members and routes (label pills).
  const extent: Box[] = []
  const lanes = members.filter((id) => ctx.node.get(id)!.lane === true && inner.has(id))
  if (inLane) {
    arrangeRow(ctx, members, size, level, direction, rel, routes, extent)
  } else if (lanes.length > 0) {
    arrangeLanes(ctx, members, lanes, size, inner, level, direction, rel)
  } else if (algorithm === 'layered') {
    const flow = level.filter((l) => !l.e.loop)
    const res = await elkLayered(
      members.map((id) => ({ id, ...size.get(id)! })),
      flow.map((l) => ({ id: l.e.id, source: l.a, target: l.b })),
      direction,
      ctx.spacing,
    )
    for (const [id, p] of res.pos) rel.set(id, p)
    for (const l of flow) {
      if (!l.direct) continue
      ctx.kind.set(l.e.id, 'flow')
      const r = res.routes.get(l.e.id)
      if (r) routes.set(l.e.id, r)
    }
    const loops = level
      .filter((l) => l.e.loop && l.direct && l.e.source !== l.e.target)
      .map((l) => l.e)
    loopRoutes(ctx, members, rel, size, loops, direction, routes)
  } else if (algorithm === 'grid') {
    arrangeGrid(ctx, members, size, direction, rel)
  } else {
    await arrangeTree(ctx, members, size, level, algorithm, direction, rel)
  }

  for (const id of members) extent.push({ ...rel.get(id)!, ...size.get(id)! })
  for (const r of routes.values()) for (const p of r) extent.push({ x: p.x, y: p.y, w: 0, h: 0 })
  const bb = unionBox(extent) ?? { x: 0, y: 0, w: 0, h: 0 }
  const out: Content = {
    pos: new Map(),
    frameSizes: new Map(),
    routes: new Map(),
    w: bb.w,
    h: bb.h,
  }
  for (const id of members) {
    const p = { x: rel.get(id)!.x - bb.x, y: rel.get(id)!.y - bb.y }
    out.pos.set(id, p)
    const c = inner.get(id)
    if (!c) continue
    const add = (q: Point) => ({ x: p.x + q.x, y: p.y + q.y })
    out.frameSizes.set(id, size.get(id)!)
    for (const [k, q] of c.pos) out.pos.set(k, add(q))
    for (const [k, s] of c.frameSizes) out.frameSizes.set(k, s)
    for (const [k, r] of c.routes) out.routes.set(k, r.map(add))
  }
  for (const [k, r] of routes)
    out.routes.set(
      k,
      r.map((q) => ({ x: q.x - bb.x, y: q.y - bb.y })),
    )
  return out
}

/**
 * Slides blocks along the flow (right, or down) past `obstacles`: the first block that hits
 * one moves just past it, with every block at or after its place, so rows and columns keep
 * their alignment. If that does not settle, the whole layout goes under every obstacle.
 */
function avoid(
  blocks: Array<{ id: string; box: Box }>,
  obstacles: Box[],
  direction: LayoutDirection,
  spacing: number,
): Map<string, Point> {
  const shift = new Map(blocks.map((b) => [b.id, { x: 0, y: 0 }]))
  if (obstacles.length === 0 || blocks.length === 0) return shift
  const rows = direction === 'right'
  const boxes = blocks.map((b) => ({ ...b.box }))
  const along = (b: Box) => (rows ? b.x : b.y)
  const across = (b: Box) => (rows ? b.y : b.x)
  const limit = blocks.length * obstacles.length + 10
  for (let iter = 0; ; iter++) {
    const order = boxes
      .map((_, i) => i)
      .sort(
        (p, q) =>
          along(boxes[p]!) - along(boxes[q]!) || across(boxes[p]!) - across(boxes[q]!) || p - q,
      )
    let hit: { i: number; o: Box } | null = null
    for (const i of order) {
      const o = obstacles.find((ob) => boxesOverlap(boxes[i]!, ob, spacing / 2))
      if (o) {
        hit = { i, o }
        break
      }
    }
    if (!hit) return shift
    if (iter >= limit) {
      const all = unionBox(blocks.map((b) => b.box))!
      const dy = bottom(unionBox(obstacles)!) + spacing * 2 - all.y
      for (const b of blocks) shift.set(b.id, { x: 0, y: dy })
      return shift
    }
    const from = along(boxes[hit.i]!)
    const d = (rows ? right(hit.o) : bottom(hit.o)) + spacing - from
    boxes.forEach((b, k) => {
      if (along(b) < from - 0.5) return
      const s = shift.get(blocks[k]!.id)!
      if (rows) {
        b.x += d
        s.x += d
      } else {
        b.y += d
        s.y += d
      }
    })
  }
}

/** Whether `route` leaves `S` through the side it first travels to and enters `T` the same way. */
function endsOn(route: Point[], S: Box, T: Box): boolean {
  const n = route.length
  if (n < 2) return false
  const out = travelSide(route[0]!, route[1]!)
  const into = travelSide(route[n - 2]!, route[n - 1]!)
  if (!out || !into) return false
  const on = (b: Box, side: Side, p: Point) => {
    const c = sideCenter(b, side)
    return side === 'left' || side === 'right'
      ? Math.abs(p.x - c.x) <= 1 && p.y >= b.y - 1 && p.y <= bottom(b) + 1
      : Math.abs(p.y - c.y) <= 1 && p.x >= b.x - 1 && p.x <= right(b) + 1
  }
  return on(S, out, route[0]!) && on(T, oppositeSide(into), route[n - 1]!)
}

/** Integer points, straight runs merged; never fewer than two points. */
function rounded(route: Point[]): Point[] {
  const r = simplifyRoute(route.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })))
  return r.length >= 2 ? r : [r[0]!, r[0]!]
}

/**
 * Places the board's cards and routes its links. See ./index.ts for the rules; the result
 * holds only cards that moved (absolute top lefts, integers), frames that grew around their
 * children, routes for every link touching a moved card, and the pinned cards kept.
 */
export async function layoutBoard(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: LayoutOptions,
): Promise<LayoutResult> {
  const result: LayoutResult = {
    positions: new Map(),
    frameSizes: new Map(),
    edges: new Map(),
    kept: [],
  }
  const spacing = finite(opts.spacing) && opts.spacing > 0 ? Math.max(8, opts.spacing) : 48
  const direction: LayoutDirection = opts.direction === 'down' ? 'down' : 'right'
  const algorithm: LayoutAlgorithm = (['layered', 'grid', 'radial', 'mrtree'] as const).includes(
    opts.algorithm,
  )
    ? opts.algorithm
    : 'layered'

  const node = new Map<string, LayoutNode>()
  const index = new Map<string, number>()
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || n.id === '' || node.has(n.id)) continue
    index.set(n.id, index.size)
    node.set(n.id, {
      ...n,
      w: finite(n.w) && n.w > 0 ? n.w : 1,
      h: finite(n.h) && n.h > 0 ? n.h : 1,
    })
  }
  const parent = new Map<string, string>()
  for (const [id, n] of node) {
    const p = n.parent === undefined ? undefined : node.get(n.parent)
    if (p && p.id !== id && (p.frame === true || p.lane === true)) parent.set(id, p.id)
  }
  for (const id of node.keys()) {
    let cur = parent.get(id)
    for (let i = 0; cur !== undefined && i <= node.size; i++) {
      if (cur === id) {
        parent.delete(id)
        break
      }
      cur = parent.get(cur)
    }
  }
  const ancestors = (id: string): string[] => {
    const out: string[] = []
    for (let cur = parent.get(id); cur !== undefined; cur = parent.get(cur)) out.push(cur)
    return out
  }
  const placedBefore = (n: LayoutNode) => finite(n.x) && finite(n.y)
  const pinned = (id: string) => {
    const n = node.get(id)!
    return opts.keepPinned && n.pinned === true && placedBefore(n)
  }
  const only = opts.only ?? null
  const moving = new Set<string>()
  for (const [id, n] of node) {
    const chain = [id, ...ancestors(id)]
    if (only && !chain.some((a) => only.has(a))) continue
    if (chain.some(pinned)) {
      if (placedBefore(n)) result.kept.push(id)
      continue
    }
    moving.add(id)
  }
  const kids = new Map<string, string[]>()
  const top: string[] = []
  const topSet = new Set<string>()
  for (const id of moving) {
    const p = parent.get(id)
    if (p !== undefined && moving.has(p)) kids.set(p, [...(kids.get(p) ?? []), id])
    else {
      top.push(id)
      topSet.add(id)
    }
  }

  const edgeList: Edge[] = []
  const edgeIds = new Set<string>()
  for (const e of edges) {
    if (!e || typeof e.id !== 'string' || edgeIds.has(e.id)) continue
    if (!node.has(e.source) || !node.has(e.target)) continue
    edgeIds.add(e.id)
    edgeList.push({
      id: e.id,
      source: e.source,
      target: e.target,
      label: typeof e.label === 'string' && e.label !== '' ? e.label : undefined,
      toneLoop: e.tone === 'loop',
      loop: e.tone === 'loop' || e.source === e.target,
    })
  }
  markLoops(edgeList, [...node.keys()])

  const ctx: Ctx = {
    spacing,
    clearance: clamp(Math.round(spacing / 4), 6, 16),
    columns: finite(opts.columns) && opts.columns >= 1 ? opts.columns : undefined,
    node,
    index,
    parent,
    kids,
    moving,
    edges: edgeList,
    kind: new Map(),
    rowOf: new Map(),
    rowEnds: new Set(),
  }
  const content = await layoutMembers(ctx, top, algorithm, direction)

  // Where the moved set goes: where it was, else under what stays, else the origin.
  const sizeOf = (id: string): Size =>
    content.frameSizes.get(id) ?? { w: node.get(id)!.w, h: node.get(id)!.h }
  const before = unionBox(
    [...moving]
      .map((id) => node.get(id)!)
      .filter(placedBefore)
      .map((n) => ({ x: n.x!, y: n.y!, w: n.w, h: n.h })),
  )
  const around = new Set<string>()
  for (const id of moving) for (const a of ancestors(id)) around.add(a)
  const fixed = new Map<string, Box>()
  for (const [id, n] of node)
    if (!moving.has(id) && placedBefore(n)) fixed.set(id, { x: n.x!, y: n.y!, w: n.w, h: n.h })
  const obstacles = [...fixed].filter(([id]) => !around.has(id)).map(([, b]) => b)
  const stays = unionBox(obstacles)
  const origin = before
    ? { x: before.x, y: before.y }
    : stays
      ? { x: stays.x, y: bottom(stays) + spacing * 2 }
      : { x: 0, y: 0 }
  const shift = avoid(
    top.map((id) => {
      const p = content.pos.get(id)!
      return { id, box: { x: origin.x + p.x, y: origin.y + p.y, ...sizeOf(id) } }
    }),
    obstacles,
    direction,
    spacing,
  )
  const topOf = (id: string) => {
    let cur = id
    while (!topSet.has(cur)) cur = parent.get(cur)!
    return cur
  }
  const offset = (id: string) => {
    const s = shift.get(topOf(id))!
    return { x: origin.x + s.x, y: origin.y + s.y }
  }
  for (const [id, p] of content.pos) {
    const o = offset(id)
    result.positions.set(id, { x: Math.round(o.x + p.x), y: Math.round(o.y + p.y) })
  }
  for (const [id, s] of content.frameSizes)
    result.frameSizes.set(id, { w: Math.round(s.w), h: Math.round(s.h) })

  // Links.
  const boxOf = new Map<string, Box>()
  for (const id of node.keys()) {
    const p = result.positions.get(id)
    if (p) boxOf.set(id, { ...p, ...(result.frameSizes.get(id) ?? sizeOf(id)) })
    else if (fixed.has(id)) boxOf.set(id, fixed.get(id)!)
  }
  const cards = [...boxOf]
  const laneOf = new Map<string, string>()
  for (const id of moving) {
    const lane = ancestors(id).find((a) => node.get(a)!.lane === true && kids.has(a))
    if (lane !== undefined) laneOf.set(id, lane)
  }
  const flowOut: Side = direction === 'right' ? 'right' : 'bottom'
  const loopSide: Side = direction === 'right' ? 'bottom' : 'right'
  const skipSide = oppositeSide(loopSide)
  const facing = (a: Box, b: Box): Side => {
    const gaps: Array<[Side, number]> = [
      ['right', b.x - right(a)],
      ['bottom', b.y - bottom(a)],
      ['left', a.x - right(b)],
      ['top', a.y - bottom(b)],
    ]
    return gaps.reduce((m, g) => (g[1] > m[1] ? g : m))[0]
  }
  // A lane step takes a link from another lane on the side toward it (rows: bottom or top,
  // through the gutter between lanes; columns: right or left), one to another row of its lane
  // the same way, and any other link on the side over its row (rows: top; columns: left), or
  // out of the lane's end when it ends a row and the other card lies past the lane; elsewhere
  // the side facing the other end.
  const endSide = (id: string, otherId: string, other: Box): Side => {
    const lane = laneOf.get(id)
    const L = lane === undefined ? undefined : boxOf.get(lane)
    if (!L) return facing(boxOf.get(id)!, other)
    const across = laneOf.get(otherId)
    if (across === lane) {
      const d = (ctx.rowOf.get(otherId) ?? 0) - (ctx.rowOf.get(id) ?? 0)
      return d > 0 ? loopSide : skipSide
    }
    if (across === undefined) {
      const past = direction === 'right' ? other.x >= right(L) : other.y >= bottom(L)
      return ctx.rowEnds.has(id) && past ? flowOut : skipSide
    }
    return direction === 'right'
      ? centerY(other) >= bottom(L)
        ? 'bottom'
        : 'top'
      : centerX(other) >= right(L)
        ? 'right'
        : 'left'
  }

  type Pending = { e: Edge; S: Box; T: Box; others: Box[]; nested: boolean; ss: Side; ts: Side }
  const done = new Map<string, Point[]>()
  const pending: Pending[] = []
  // Ends sharing a card side: kept routes' ends are taken, new ones spread over the rest.
  const sides = new Map<
    string,
    { box: Box; side: Side; taken: number[]; ends: Array<{ key: string; other: number }> }
  >()
  const sideOf = (id: string, box: Box, side: Side) => {
    const k = `${id}\0${side}`
    let g = sides.get(k)
    if (!g) sides.set(k, (g = { box, side, taken: [], ends: [] }))
    return g
  }
  const axisOf = (side: Side, p: Point) => (side === 'top' || side === 'bottom' ? p.x : p.y)
  for (const e of edgeList) {
    if (!moving.has(e.source) && !moving.has(e.target)) continue
    const S = boxOf.get(e.source)
    const T = boxOf.get(e.target)
    if (!S || !T) continue
    const sUp = ancestors(e.source)
    const tUp = ancestors(e.target)
    const skip = new Set([e.source, e.target, ...sUp, ...tUp])
    const others = cards.filter(([id]) => !skip.has(id)).map(([, b]) => b)
    const nested = sUp.includes(e.target) || tUp.includes(e.source)
    const local = content.routes.get(e.id)
    if (local) {
      const a = offset(e.source)
      const b = offset(e.target)
      if (a.x === b.x && a.y === b.y) {
        const r = rounded(local.map((p) => ({ x: p.x + a.x, y: p.y + a.y })))
        if (endsOn(r, S, T) && routeIsClean(r, S, T, others, !nested)) {
          done.set(e.id, r)
          const out = travelSide(r[0]!, r[1]!)!
          const into = oppositeSide(travelSide(r[r.length - 2]!, r[r.length - 1]!)!)
          sideOf(e.source, S, out).taken.push(axisOf(out, r[0]!))
          sideOf(e.target, T, into).taken.push(axisOf(into, r[r.length - 1]!))
          continue
        }
      }
    }
    const kind = ctx.kind.get(e.id)
    const [ss, ts]: [Side, Side] =
      e.source === e.target
        ? [flowOut, loopSide]
        : kind === 'flow'
          ? [flowOut, oppositeSide(flowOut)]
          : kind === 'loop'
            ? [loopSide, loopSide]
            : kind === 'skip'
              ? [skipSide, skipSide]
              : kind === 'drop'
                ? [loopSide, skipSide]
                : [endSide(e.source, e.target, T), endSide(e.target, e.source, S)]
    pending.push({ e, S, T, others, nested, ss, ts })
    sideOf(e.source, S, ss).ends.push({
      key: `${e.id}\0s`,
      other: axisOf(ss, { x: centerX(T), y: centerY(T) }),
    })
    // A link from another lane hooks in from the gap beside its target (gutterDrop): its end
    // goes outermost on that side, so the hook passes over no other end.
    const from = axisOf(ts, { x: centerX(S), y: centerY(S) })
    const ls = laneOf.get(e.source)
    const lt = laneOf.get(e.target)
    const hooked = ls !== undefined && lt !== undefined && ls !== lt
    const toward = from >= axisOf(ts, { x: centerX(T), y: centerY(T) }) ? 1e9 : -1e9
    sideOf(e.target, T, ts).ends.push({ key: `${e.id}\0t`, other: hooked ? toward : from })
  }
  const port = new Map<string, Point>()
  for (const g of sides.values()) {
    const m = g.ends.length + g.taken.length
    if (g.ends.length === 0 || m < 2) continue
    const flat = g.side === 'top' || g.side === 'bottom'
    const start = flat ? g.box.x : g.box.y
    const len = flat ? g.box.w : g.box.h
    const slots = Array.from({ length: m }, (_, k) => start + (len * (k + 1)) / (m + 1))
    for (const t of g.taken) {
      let best = 0
      slots.forEach((s, k) => {
        if (Math.abs(s - t) < Math.abs(slots[best]! - t)) best = k
      })
      slots.splice(best, 1)
    }
    const edge = sideCenter(g.box, g.side)
    ;[...g.ends]
      .sort((a, b) => a.other - b.other)
      .forEach((end, k) =>
        port.set(end.key, flat ? { x: slots[k]!, y: edge.y } : { x: edge.x, y: slots[k]! }),
      )
  }
  // Two cards facing each other across a gap that one straight line can span get one.
  for (const { e, S, T, ss, ts } of pending) {
    const sKey = `${e.id}\0s`
    const tKey = `${e.id}\0t`
    if (port.has(sKey) || port.has(tKey) || ts !== oppositeSide(ss) || e.source === e.target)
      continue
    const flat = ss === 'top' || ss === 'bottom'
    const lo = Math.max(flat ? S.x : S.y, flat ? T.x : T.y) + 12
    const hi = Math.min(flat ? right(S) : bottom(S), flat ? right(T) : bottom(T)) - 12
    if (lo > hi) continue
    const v = Math.round((lo + hi) / 2)
    const a = sideCenter(S, ss)
    const b = sideCenter(T, ts)
    port.set(sKey, flat ? { x: v, y: a.y } : { x: a.x, y: v })
    port.set(tKey, flat ? { x: v, y: b.y } : { x: b.x, y: v })
  }
  // A lane step linked out of its lane leaves the lane first, out to the middle of the gutter
  // beyond it (over its arcs and heading, rather than along them inside the lane); one whose
  // side sits on the lane's thin padding does so for any link, so none runs along its edge.
  const laneGap = Math.round(spacing * 1.5)
  const reach = (id: string, b: Box, side: Side, otherId: string): number | undefined => {
    const lane = laneOf.get(id)
    const L = lane === undefined ? undefined : boxOf.get(lane)
    if (!L) return undefined
    const dist =
      side === 'left'
        ? b.x - L.x
        : side === 'right'
          ? right(L) - right(b)
          : side === 'top'
            ? b.y - L.y
            : bottom(L) - bottom(b)
    return dist <= FRAME_PAD + 4 || laneOf.get(otherId) !== lane ? dist + laneGap / 2 : undefined
  }
  // Interior segments (not the ones on a card) that would run on top of an unrelated link's
  // move aside, while the route stays clean. Links sharing a card may share a bus.
  type Seg = { flat: boolean; at: number; lo: number; hi: number; cards: [string, string] }
  const segs: Seg[] = []
  const segsOf = (r: Point[], e: Edge): Seg[] =>
    r.slice(1).map((b, k) => {
      const a = r[k]!
      const flat = a.y === b.y
      const cards: [string, string] = [e.source, e.target]
      return flat
        ? { flat, at: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), cards }
        : { flat, at: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y), cards }
    })
  for (const e of edgeList) {
    const r = done.get(e.id)
    if (r) segs.push(...segsOf(r, e))
  }
  const MIN_APART = 6
  const clash = (s: Seg) =>
    segs.some(
      (o) =>
        o.flat === s.flat &&
        Math.abs(o.at - s.at) < MIN_APART &&
        o.lo < s.hi &&
        s.lo < o.hi &&
        !o.cards.some((c) => s.cards.includes(c)),
    )
  const separate = (route: Point[], p: Pending): Point[] => {
    let r = route
    const n = r.length
    const len = (q: Point[], k: number) =>
      Math.abs(q[k + 1]!.x - q[k]!.x) + Math.abs(q[k + 1]!.y - q[k]!.y)
    const stubs = Math.min(len(r, 0), len(r, n - 2), 8)
    for (let i = 1; i + 2 < n; i++) {
      const s = segsOf(r, p.e)[i]!
      if (!clash(s)) continue
      for (const d of [8, -8, 16, -16, 24, -24]) {
        if (clash({ ...s, at: s.at + d })) continue
        const moved = r.map((q, k) =>
          k === i || k === i + 1 ? (s.flat ? { x: q.x, y: q.y + d } : { x: q.x + d, y: q.y }) : q,
        )
        if (
          len(moved, 0) >= stubs &&
          len(moved, n - 2) >= stubs &&
          endsOn(moved, p.S, p.T) &&
          routeIsClean(moved, p.S, p.T, p.others, !p.nested) &&
          !routeCrossesCards(moved.slice(1, -1), p.others, -4)
        ) {
          r = moved
          break
        }
      }
    }
    return r
  }
  // A link between lanes crosses the gutter between them, then runs down the gap beside its
  // target step (on the side toward the source) and hooks in just over it, rather than
  // dropping onto the step straight over the lane's heading. Null when that is not clean.
  const gutterDrop = (p: Pending, P: Point, Q: Point): Point[] | null => {
    const { e, S, T, ss, ts } = p
    const ls = laneOf.get(e.source)
    const lt = laneOf.get(e.target)
    if (ls === undefined || lt === undefined || ls === lt) return null
    // Work as if the lanes stacked as rows; `down` is the same transposed.
    const t = direction === 'down'
    const f = (q: Point): Point => (t ? { x: q.y, y: q.x } : q)
    const fb = (b: Box): Box => (t ? { x: b.y, y: b.x, w: b.h, h: b.w } : b)
    const fs = (s: Side): Side => (t ? TRANSPOSED[s] : s)
    const LS = fb(boxOf.get(ls)!)
    const LT = fb(boxOf.get(lt)!)
    const Tf = fb(T)
    const down = fs(ss) === 'bottom' && fs(ts) === 'top'
    if (!down && !(fs(ss) === 'top' && fs(ts) === 'bottom')) return null
    const gy = down ? (bottom(LS) + LT.y) / 2 : (bottom(LT) + LS.y) / 2
    const p0 = f(P)
    const q0 = f(Q)
    const row = (kids.get(lt) ?? [])
      .filter((id) => id !== e.target && ctx.rowOf.get(id) === ctx.rowOf.get(e.target))
      .map((id) => fb(boxOf.get(id)!))
    const after = row.filter((b) => b.x >= right(Tf)).sort((a, b) => a.x - b.x)[0]
    const before = row.filter((b) => right(b) <= Tf.x).sort((a, b) => right(b) - right(a))[0]
    const cols: number[] = []
    if (after) cols.push((right(Tf) + after.x) / 2)
    if (before) cols.push((right(before) + Tf.x) / 2)
    if (p0.x < centerX(Tf)) cols.reverse()
    const hook = down ? Tf.y - 8 : bottom(Tf) + 8
    for (const dx of cols) {
      const r = rounded(
        [
          p0,
          { x: p0.x, y: gy },
          { x: dx, y: gy },
          { x: dx, y: hook },
          { x: q0.x, y: hook },
          q0,
        ].map(f),
      )
      if (
        endsOn(r, S, T) &&
        routeIsClean(r, S, T, p.others, !p.nested) &&
        !routeCrossesCards(r, p.others, -Math.max(2, ctx.clearance / 2))
      )
        return r
    }
    return null
  }
  for (const p of pending) {
    const { e, S, T, others, nested, ss, ts } = p
    const req = {
      source: {
        box: S,
        side: ss,
        at: port.get(`${e.id}\0s`),
        reach: reach(e.source, S, ss, e.target),
      },
      target: {
        box: T,
        side: ts,
        at: port.get(`${e.id}\0t`),
        reach: reach(e.target, T, ts, e.source),
      },
      obstacles: others,
      bands: cards.filter(([id]) => id !== e.source && id !== e.target).map(([, b]) => b),
      avoidEnds: !nested,
      clearance: ctx.clearance,
    }
    const r =
      gutterDrop(p, req.source.at ?? sideCenter(S, ss), req.target.at ?? sideCenter(T, ts)) ??
      routeLink(req)
    // Walled in (cards that stay overlap it): the plain shape, best effort.
    const route = r ? separate(rounded(r), p) : rounded(elbowLink(req))
    done.set(e.id, route)
    segs.push(...segsOf(route, e))
  }
  for (const e of edgeList) {
    const r = done.get(e.id)
    if (r) result.edges.set(e.id, laid(r, e.loop))
  }
  return result
}

function laid(route: Point[], loop: boolean): LaidEdge {
  const n = route.length
  return {
    sourceHandle: travelSide(route[0]!, route[1]!) ?? 'right',
    targetHandle: oppositeSide(travelSide(route[n - 2]!, route[n - 1]!) ?? 'right'),
    route,
    loop,
  }
}
