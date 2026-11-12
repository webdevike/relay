import type {
  CanvasBoard,
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeKind,
} from '@evaos/contract'

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

/** A card's box when the board is not on screen to measure it: the file's, else a typical size. */
export function fileBox(n: CanvasNode): Box | null {
  if (n.x === undefined || n.y === undefined) return null
  return { x: n.x, y: n.y, w: n.w ?? (n.type === 'note' ? 220 : 240), h: n.h ?? 120 }
}

/** Every placed top-level card's box: the drawn ones (`drawn`, absolute) win over the file's. */
export function boxesOf(
  nodes: readonly CanvasNode[],
  drawn: Readonly<Record<string, Box>> | null,
): Map<string, Box> {
  const out = new Map<string, Box>()
  for (const n of nodes) {
    const box = drawn?.[n.id] ?? fileBox(n)
    if (box) out.set(n.id, box)
  }
  return out
}

/** Space between a new card and its neighbor. */
const GAP = 80

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.w + GAP / 2 &&
  b.x < a.x + a.w + GAP / 2 &&
  a.y < b.y + b.h + GAP / 2 &&
  b.y < a.y + a.h + GAP / 2

/**
 * Where a new `size` card goes: right of `near` (sliding down past cards in the way), else below
 * everything, left-aligned with it; the origin on an empty board.
 */
export function placeNew(
  boxes: ReadonlyMap<string, Box>,
  size: { w: number; h: number },
  near?: string,
): { x: number; y: number } {
  const all = [...boxes.values()]
  const anchor = near === undefined ? undefined : boxes.get(near)
  if (anchor) {
    const spot = { x: anchor.x + anchor.w + GAP, y: anchor.y, ...size }
    for (let i = 0; i < 50 && all.some((b) => overlaps(spot, b)); i++) {
      const hit = all.filter((b) => overlaps(spot, b))
      spot.y = Math.max(...hit.map((b) => b.y + b.h)) + GAP / 2
    }
    return { x: Math.round(spot.x), y: Math.round(spot.y) }
  }
  if (all.length === 0) return { x: 0, y: 0 }
  return {
    x: Math.round(Math.min(...all.map((b) => b.x))),
    y: Math.round(Math.max(...all.map((b) => b.y + b.h)) + GAP),
  }
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
    })),
  }
}
