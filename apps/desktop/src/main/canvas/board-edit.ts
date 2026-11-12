import type {
  CanvasBoard,
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeKind,
} from '@evaos/contract'
import { FRAME_HEADER, FRAME_PAD, LANE_HEADER } from '../../shared/canvas-layout'
import type { LaidEdge, LayoutEdge, LayoutNode } from '../../shared/canvas-layout/types'

/**
 * The board changes an agent makes through the canvas drive (canvas.add, edit, move, connect,
 * delete), as pure functions over one page of a board, plus where a new card goes and how the
 * board reads back to the agent. The renderer's board-model.ts keeps the drawing-side rules.
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A card's size before the board draws it: the renderer's default width per kind (board-model
 * defaultWidth) and a typical height.
 */
export function typicalSize(kind: CanvasNodeKind): { w: number; h: number } {
  switch (kind) {
    case 'note':
      return { w: 220, h: 120 }
    case 'frame':
      return { w: 330, h: 220 }
    case 'ui':
      return { w: 420, h: 280 }
    case 'proto':
      return { w: 960, h: 600 }
    case 'suggestion':
    case 'typography':
      return { w: 260, h: 120 }
    case 'step':
      return { w: 300, h: 96 }
    case 'explainer':
      return { w: 380, h: 200 }
    default:
      return { w: 240, h: 120 }
  }
}

/** A card's box when the board is not on screen to measure it: the file's, else a typical size. */
export function fileBox(n: CanvasNode): Box | null {
  if (n.x === undefined || n.y === undefined) return null
  const t = typicalSize(n.type)
  return { x: n.x, y: n.y, w: n.w ?? t.w, h: n.h ?? t.h }
}

/** Every placed card's box (frames' children too, absolute): the drawn ones win over the file's. */
export function boxesOf(
  nodes: readonly CanvasNode[],
  drawn: Readonly<Record<string, Box>> | null,
): Map<string, Box> {
  const out = new Map<string, Box>()
  for (const n of nodes) {
    // A card the board has not measured yet is drawn 0 x 0: the file's box stands in for it.
    const seen = drawn?.[n.id]
    const box = seen && seen.w > 0 && seen.h > 0 ? seen : fileBox(n)
    if (box) out.set(n.id, box)
  }
  return out
}

/** Space between a new card and its neighbor. */
const GAP = 80
/** A row of new cards wraps below everything past this many cards or this width. */
const ROW_CARDS = 4
const ROW_WIDTH = 1500

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w + GAP / 2 &&
  b.x < a.x + a.w + GAP / 2 &&
  a.y < b.y + b.h + GAP / 2 &&
  b.y < a.y + a.h + GAP / 2

const rounded = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: Math.round(p.x),
  y: Math.round(p.y),
})

/** `spot`, slid down past every obstacle in its way. */
function slide(spot: Box, obstacles: readonly Box[]): { x: number; y: number } {
  const at = { ...spot }
  for (let i = 0; i < 50 && obstacles.some((b) => overlaps(at, b)); i++) {
    const hit = obstacles.filter((b) => overlaps(at, b))
    at.y = Math.max(...hit.map((b) => b.y + b.h)) + GAP / 2
  }
  return rounded(at)
}

/** Frame `id` and the frames it sits in. */
function framesUp(board: CanvasBoard, id: string): Set<string> {
  const out = new Set<string>()
  for (let cur: string | undefined = id; cur !== undefined && !out.has(cur);) {
    out.add(cur)
    cur = board.nodes.find((n) => n.id === cur)?.parent
  }
  return out
}

/** Every card inside frame `id`, nested frames' cards too (not the frame itself). */
export function descendantsOf(board: CanvasBoard, id: string): Set<string> {
  const out = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const n of board.nodes) {
      if (n.parent === undefined || out.has(n.id) || n.id === id) continue
      if (n.parent === id || out.has(n.parent)) {
        out.add(n.id)
        grew = true
      }
    }
  }
  return out
}

/** How a new card is placed: by the card it follows, the card it sits by, or its frame. */
export interface Placing {
  /** Right of this card, sliding down past cards in the way. */
  near?: string | undefined
  /** After this card by the graph: right of it when free, else under its lowest linked card. */
  from?: string | undefined
  /** Inside this frame, after its last card. */
  parent?: string | undefined
}

/**
 * Where a new `size` card goes on `board` (`boxes`: every placed card, absolute), never on top of
 * another: in frame `parent` right of its last card (its first card at the frame's top left);
 * after `from`; right of `near`; else right of the last card added while its row is short, else
 * a new row below everything, left-aligned with it; the origin on an empty board. Null when the
 * frame it goes in has no place yet (the board places it under its siblings).
 */
export function placeNew(
  board: CanvasBoard,
  boxes: ReadonlyMap<string, Box>,
  size: { w: number; h: number },
  how: Placing = {},
): { x: number; y: number } | null {
  const all = [...boxes.values()]
  if (how.parent !== undefined) {
    const frame = boxes.get(how.parent)
    if (!frame) return null
    const around = framesUp(board, how.parent)
    const obstacles = [...boxes].filter(([id]) => !around.has(id)).map(([, b]) => b)
    const last = board.nodes
      .filter((n) => n.parent === how.parent)
      .flatMap((n) => boxes.get(n.id) ?? [])
      .at(-1)
    const spot = last
      ? { x: last.x + last.w + GAP, y: last.y, ...size }
      : {
          x: frame.x + FRAME_PAD,
          y:
            frame.y +
            (board.nodes.find((n) => n.id === how.parent)?.data?.variant === 'lane'
              ? LANE_HEADER
              : FRAME_HEADER) +
            FRAME_PAD,
          ...size,
        }
    return slide(spot, obstacles)
  }
  const from = how.from === undefined ? undefined : boxes.get(how.from)
  if (from) {
    const right = { x: from.x + from.w + GAP, y: from.y, ...size }
    if (!all.some((b) => overlaps(right, b))) return rounded(right)
    const lowest = board.edges
      .filter((e) => e.source === how.from && e.target !== how.from)
      .flatMap((e) => boxes.get(e.target) ?? [])
      .reduce<Box | null>((low, b) => (low && low.y + low.h >= b.y + b.h ? low : b), null)
    if (lowest) return slide({ x: lowest.x, y: lowest.y + lowest.h + GAP / 2, ...size }, all)
    return slide(right, all)
  }
  const anchor = how.near === undefined ? undefined : boxes.get(how.near)
  if (anchor) return slide({ x: anchor.x + anchor.w + GAP, y: anchor.y, ...size }, all)
  if (all.length === 0) return { x: 0, y: 0 }
  const cards = board.nodes.filter(
    (n) => n.type !== 'frame' && n.parent === undefined && boxes.has(n.id),
  )
  const prev = cards.at(-1)
  if (prev) {
    const p = boxes.get(prev.id)!
    const row = cards.map((n) => boxes.get(n.id)!).filter((b) => Math.abs(b.y - p.y) < 1)
    const left = Math.min(...row.map((b) => b.x))
    const spot = { x: p.x + p.w + GAP, y: p.y, ...size }
    const fits = row.length < ROW_CARDS && spot.x + spot.w - left <= ROW_WIDTH
    if (fits && !all.some((b) => overlaps(spot, b))) return rounded(spot)
  }
  return {
    x: Math.round(Math.min(...all.map((b) => b.x))),
    y: Math.round(Math.max(...all.map((b) => b.y + b.h)) + GAP),
  }
}

/**
 * The size frame `frame` (drawn at `box`) grows to so card `card` sits inside it with its
 * padding; null when it already fits.
 */
export function grownFrame(box: Box, card: Box): { w: number; h: number } | null {
  const w = Math.max(box.w, card.x + card.w + FRAME_PAD - box.x)
  const h = Math.max(box.h, card.y + card.h + FRAME_PAD - box.y)
  return w > box.w || h > box.h ? { w: Math.round(w), h: Math.round(h) } : null
}

/** `<kind>-<n>` from the node count up, skipping ids in use (the board's `note-<n>` rule). */
export function freshNodeId(kind: CanvasNodeKind, ids: readonly string[]): string {
  const used = new Set(ids)
  let n = ids.length + 1
  while (used.has(`${kind}-${n}`)) n += 1
  return `${kind}-${n}`
}

/** An edge id `<from>-<to>` that is not taken yet. */
export function freshEdgeId(from: string, to: string, ids: readonly string[]): string {
  const used = new Set(ids)
  const base = `${from}-${to}`
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code })

/** The card `id`, or a `not-found` naming canvas.read. */
export function nodeOf(board: CanvasBoard, id: string): CanvasNode {
  const n = board.nodes.find((x) => x.id === id)
  if (!n) throw coded('not-found', `No card ${id} on this page; canvas.read lists them`)
  return n
}

/** Data fields with undefined values dropped (so an edit never writes `"title": undefined`). */
function cleanData(data: CanvasNodeData): CanvasNodeData {
  return Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined),
  ) as CanvasNodeData
}

export interface NewCard {
  type: CanvasNodeKind
  data: CanvasNodeData
  at?: { x: number; y: number }
  w?: number
  h?: number
  parent?: string
}

export function addCard(board: CanvasBoard, card: NewCard): { board: CanvasBoard; id: string } {
  if (card.parent !== undefined) nodeOf(board, card.parent)
  const id = freshNodeId(
    card.type,
    board.nodes.map((n) => n.id),
  )
  const data = cleanData(card.data)
  const node: CanvasNode = {
    id,
    type: card.type,
    ...(card.at ? { x: card.at.x, y: card.at.y } : {}),
    ...(card.w === undefined ? {} : { w: card.w }),
    ...(card.h === undefined ? {} : { h: card.h }),
    ...(card.parent === undefined ? {} : { parent: card.parent }),
    ...(Object.keys(data).length ? { data } : {}),
  }
  return { board: { ...board, nodes: [...board.nodes, node] }, id }
}

/** Merges `data` into card `id` (a field set to "" clears it), and changes its kind or size. */
export function editCard(
  board: CanvasBoard,
  id: string,
  change: { data: CanvasNodeData; type?: CanvasNodeKind; w?: number; h?: number },
): CanvasBoard {
  nodeOf(board, id)
  return {
    ...board,
    nodes: board.nodes.map((n) => {
      if (n.id !== id) return n
      const merged = Object.fromEntries(
        Object.entries({ ...n.data, ...cleanData(change.data) }).filter(([, v]) => v !== ''),
      ) as CanvasNodeData
      const { data: _old, ...rest } = n
      return {
        ...rest,
        ...(change.type === undefined ? {} : { type: change.type }),
        ...(change.w === undefined ? {} : { w: change.w }),
        ...(change.h === undefined ? {} : { h: change.h }),
        ...(Object.keys(merged).length ? { data: merged } : {}),
      }
    }),
  }
}

export function moveCard(
  board: CanvasBoard,
  id: string,
  to: { x: number; y: number },
): CanvasBoard {
  nodeOf(board, id)
  return {
    ...board,
    nodes: board.nodes.map((n) =>
      n.id === id ? { ...n, x: Math.round(to.x), y: Math.round(to.y) } : n,
    ),
  }
}

/** Points a link's route may keep in the file (CanvasEdgeSchema). */
const ROUTE_MAX = 40

/**
 * The page as the layout engine takes it: every card with its drawn box (`boxes`, absolute; a
 * typical size and no place for one not placed yet), its frame, lanes and pins, and every link
 * between two of its cards.
 */
export function layoutGraph(
  board: CanvasBoard,
  boxes: ReadonlyMap<string, Box>,
): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const kinds = new Map(board.nodes.map((n) => [n.id, n.type]))
  const nodes = board.nodes.map((n): LayoutNode => {
    const box = boxes.get(n.id)
    const size = box ?? typicalSize(n.type)
    const frame = n.type === 'frame'
    return {
      id: n.id,
      w: size.w,
      h: size.h,
      ...(box ? { x: box.x, y: box.y } : {}),
      ...(n.parent !== undefined && kinds.get(n.parent) === 'frame' ? { parent: n.parent } : {}),
      ...(frame ? { frame: true } : {}),
      ...(frame && n.data?.variant === 'lane' ? { lane: true } : {}),
      ...(n.pinned ? { pinned: true } : {}),
      ...(n.type === 'topic' ? { topic: true } : {}),
    }
  })
  const edges = board.edges
    .filter((e) => kinds.has(e.source) && kinds.has(e.target) && e.source !== e.target)
    .map((e): LayoutEdge => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.label === undefined ? {} : { label: e.label }),
      ...(e.tone === undefined ? {} : { tone: e.tone }),
    }))
  return { nodes, edges }
}

/**
 * Cards at new absolute top lefts `to` with the cards inside each moved frame carried along by
 * the same offset (unless `to` places them too), from their `boxes`.
 */
export function withFrameChildren(
  board: CanvasBoard,
  boxes: ReadonlyMap<string, Box>,
  to: ReadonlyMap<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  const out = new Map(to)
  for (const [id, at] of to) {
    const box = boxes.get(id)
    if (!box || board.nodes.find((n) => n.id === id)?.type !== 'frame') continue
    const dx = at.x - box.x
    const dy = at.y - box.y
    for (const child of descendantsOf(board, id)) {
      const b = boxes.get(child)
      if (b && !out.has(child)) out.set(child, { x: b.x + dx, y: b.y + dy })
    }
  }
  return out
}

/**
 * The page with cards at their new absolute top lefts `to`, frames grown to `sizes`, and links
 * along the sides and routes in `edges` (a return link marked `loop` unless it has a tone). Cards
 * and links no longer in the file are skipped; nothing here pins a card.
 */
export function arrangeCards(
  board: CanvasBoard,
  to: ReadonlyMap<string, { x: number; y: number }>,
  sizes: ReadonlyMap<string, { w: number; h: number }> = new Map(),
  edges: ReadonlyMap<string, LaidEdge> = new Map(),
): CanvasBoard {
  return {
    ...board,
    nodes: board.nodes.map((n) => {
      const at = to.get(n.id)
      const size = sizes.get(n.id)
      if (!at && !size) return n
      return {
        ...n,
        ...(at ? rounded(at) : {}),
        ...(size ? { w: Math.round(size.w), h: Math.round(size.h) } : {}),
      }
    }),
    edges: board.edges.map((e): CanvasEdge => {
      const laid = edges.get(e.id)
      if (!laid) return e
      const { route: _old, ...rest } = e
      return {
        ...rest,
        sourceHandle: laid.sourceHandle,
        targetHandle: laid.targetHandle,
        ...(laid.loop && e.tone === undefined ? { tone: 'loop' } : {}),
        ...(laid.route.length >= 2 && laid.route.length <= ROUTE_MAX
          ? { route: laid.route.map(rounded) }
          : {}),
      }
    }),
  }
}

/** A link from `from` to `to`; an existing one between them is kept (and its id answered). */
export function connectCards(
  board: CanvasBoard,
  from: string,
  to: string,
  extra: { label?: string; tone?: string },
): { board: CanvasBoard; id: string; existed: boolean } {
  nodeOf(board, from)
  nodeOf(board, to)
  if (from === to) throw coded('invalid-params', 'A link needs two different cards')
  const had = board.edges.find((e) => e.source === from && e.target === to)
  if (had) return { board, id: had.id, existed: true }
  const id = freshEdgeId(
    from,
    to,
    board.edges.map((e) => e.id),
  )
  const edge: CanvasEdge = {
    id,
    source: from,
    target: to,
    ...(extra.label ? { label: extra.label } : {}),
    ...(extra.tone ? { tone: extra.tone } : {}),
  }
  return { board: { ...board, edges: [...board.edges, edge] }, id, existed: false }
}

/**
 * Removes cards (with their links; cards inside a removed frame stay, out of it) and links.
 * Unknown ids fail before anything changes.
 */
export function removeItems(
  board: CanvasBoard,
  nodes: readonly string[],
  edges: readonly string[],
): { board: CanvasBoard; nodes: string[]; edges: string[] } {
  for (const id of nodes) nodeOf(board, id)
  for (const id of edges) {
    if (!board.edges.some((e) => e.id === id)) {
      throw coded('not-found', `No link ${id} on this page; canvas.read lists them`)
    }
  }
  const gone = new Set(nodes)
  const cut = new Set(edges)
  const removedEdges = board.edges
    .filter((e) => cut.has(e.id) || gone.has(e.source) || gone.has(e.target))
    .map((e) => e.id)
  const dropped = new Set(removedEdges)
  return {
    board: {
      ...board,
      nodes: board.nodes
        .filter((n) => !gone.has(n.id))
        .map((n) => {
          if (n.parent === undefined || !gone.has(n.parent)) return n
          const { parent: _p, ...rest } = n
          return rest
        }),
      edges: board.edges.filter((e) => !dropped.has(e.id)),
    },
    nodes: [...gone],
    edges: removedEdges,
  }
}

const clip = (s: string | undefined, max: number): string | undefined =>
  s === undefined ? undefined : s.length > max ? `${s.slice(0, max - 1)}…` : s

/** The board as canvas.read answers it: cards (id is the ref) with text and boxes, and links. */
export function readout(
  board: CanvasBoard,
  boxes: ReadonlyMap<string, Box>,
): { nodes: object[]; edges: object[] } {
  return {
    nodes: board.nodes.map((n) => {
      const d = n.data ?? {}
      const box = boxes.get(n.id)
      return {
        id: n.id,
        type: n.type,
        ...(d.title !== undefined ? { title: clip(d.title, 200) } : {}),
        ...(d.body !== undefined ? { body: clip(d.body, 600) } : {}),
        ...(d.key !== undefined ? { key: d.key } : {}),
        ...(d.status !== undefined ? { status: d.status } : {}),
        ...(d.url !== undefined ? { url: d.url } : {}),
        ...(d.caption !== undefined ? { caption: clip(d.caption, 200) } : {}),
        ...(d.src !== undefined ? { src: d.src } : {}),
        ...(n.parent !== undefined ? { parent: n.parent } : {}),
        ...(n.pinned ? { pinned: true } : {}),
        ...(box
          ? {
              x: Math.round(box.x),
              y: Math.round(box.y),
              w: Math.round(box.w),
              h: Math.round(box.h),
            }
          : { placed: false }),
      }
    }),
    edges: board.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.label ? { label: e.label } : {}),
      ...(e.tone ? { tone: e.tone } : {}),
    })),
  }
}
