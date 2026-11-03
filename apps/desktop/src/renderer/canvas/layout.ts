/**
 * Auto-layout for Canvas boards, ported from native canvas_view/layout.rs: places nodes the board
 * file gives no position, and every node on Tidy. Frames are packed first (their children in a
 * masonry of one or two columns under the frame's title), so each frame and each loose node is
 * one block; the blocks are then arranged by the board's layout:
 * - `grid`: loose nodes stacked in the first column, then one column per frame;
 * - `tree`: a mind map from the root (the first topic, else the first node nothing points to),
 *   first-level branches split right and left, each subtree centered on its parent;
 * - `flow`: layers left to right by longest path from the sources, each layer stacked and
 *   ordered by its predecessors.
 */
import type { CanvasLayout } from '@evaos/contract'

/** A node to place: its size (flow units), whether it is a frame, and the frame it sits in. */
export interface LayoutItem {
  id: string
  w: number
  h: number
  frame: boolean
  parent: string | null
  /** A topic; the tree layout roots at the first one. */
  topic: boolean
}

export type Point = readonly [number, number]
export type Size = readonly [number, number]

/** Top-left positions for every item, and the size each frame with children grew to. */
export interface Placement {
  positions: Map<string, Point>
  frameSizes: Map<string, Size>
}

/** Space between blocks and between a frame's children. */
const GAP = 48
const INNER_GAP = 16
/** A frame's padding and the band its title takes. */
export const FRAME_PAD = 16
export const FRAME_HEADER = 36
/** Horizontal space between tree depths and flow layers. */
const RANK_GAP = 96
/** Frames in a grid row before it wraps. */
const GRID_COLUMNS = 4

interface Block {
  id: string
  w: number
  h: number
  /** Children's offsets from the block's top left. */
  children: Array<[string, number, number]>
  frameSize: Size | null
}

/**
 * Places every item, arranged by `layout`, with the top left of the result at the origin.
 * `edges` are (source, target) pairs; edges to or from a frame's child count for its frame.
 */
export function place(
  layout: CanvasLayout,
  items: readonly LayoutItem[],
  edges: ReadonlyArray<readonly [string, string]>,
): Placement {
  const bs = blocks(items)
  const blockOf = new Map<string, number>()
  bs.forEach((block, ix) => {
    blockOf.set(block.id, ix)
    for (const [child] of block.children) blockOf.set(child, ix)
  })
  const links: Array<[number, number]> = []
  for (const [s, t] of edges) {
    const a = blockOf.get(s)
    const b = blockOf.get(t)
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b])
  }
  const origins =
    layout === 'grid'
      ? grid(bs, items)
      : layout === 'tree'
        ? tree(bs, items, links)
        : flow(bs, links)

  // Normalize so the top left is the origin.
  let minX = 0
  let minY = 0
  if (origins.length > 0) {
    minX = Math.min(...origins.map((o) => o[0]))
    minY = Math.min(...origins.map((o) => o[1]))
  }
  const placement: Placement = { positions: new Map(), frameSizes: new Map() }
  bs.forEach((block, ix) => {
    const x = origins[ix]![0] - minX
    const y = origins[ix]![1] - minY
    placement.positions.set(block.id, [x, y])
    for (const [child, dx, dy] of block.children) placement.positions.set(child, [x + dx, y + dy])
    if (block.frameSize) placement.frameSizes.set(block.id, block.frameSize)
  })
  return placement
}

/**
 * Packs each frame's children (masonry, two columns from four children up) and makes one block
 * per frame and per loose node, in item order.
 */
function blocks(items: readonly LayoutItem[]): Block[] {
  const frames = new Set(items.filter((i) => i.frame).map((i) => i.id))
  const inFrame = (item: LayoutItem): boolean =>
    item.parent !== null && frames.has(item.parent) && item.parent !== item.id
  const out: Block[] = []
  for (const item of items) {
    if (inFrame(item)) continue
    const children = items.filter((c) => inFrame(c) && c.parent === item.id)
    if (!item.frame || children.length === 0) {
      out.push({ id: item.id, w: item.w, h: item.h, children: [], frameSize: null })
      continue
    }
    const cols = children.length >= 4 ? 2 : 1
    const colW = children.reduce((m, c) => Math.max(m, c.w), 0)
    const heights = new Array<number>(cols).fill(0)
    const placed: Array<[string, number, number]> = []
    for (const child of children) {
      // The first shortest column.
      let col = 0
      for (let c = 1; c < cols; c++) if (heights[c]! < heights[col]!) col = c
      const dx = FRAME_PAD + col * (colW + INNER_GAP)
      const dy = FRAME_HEADER + heights[col]!
      placed.push([child.id, dx, dy])
      heights[col]! += child.h + INNER_GAP
    }
    const innerH = heights.reduce((m, h) => Math.max(m, h), 0) - INNER_GAP
    // At least wide enough for a short title.
    const w = Math.max(cols * colW + (cols - 1) * INNER_GAP + FRAME_PAD * 2, 200)
    const h = FRAME_HEADER + Math.max(innerH, 0) + FRAME_PAD
    out.push({ id: item.id, w, h, children: placed, frameSize: [w, h] })
  }
  return out
}

/** Loose nodes stacked in the first column, then a column per frame, wrapping after four. */
function grid(bs: readonly Block[], items: readonly LayoutItem[]): Array<[number, number]> {
  const isFrame = (id: string): boolean => items.some((i) => i.id === id && i.frame)
  const columns: number[][] = []
  const loose = bs.map((_, ix) => ix).filter((ix) => !isFrame(bs[ix]!.id))
  if (loose.length > 0) columns.push(loose)
  for (let ix = 0; ix < bs.length; ix++) if (isFrame(bs[ix]!.id)) columns.push([ix])

  const origins: Array<[number, number]> = bs.map(() => [0, 0])
  let x = 0
  let y = 0
  let rowH = 0
  columns.forEach((column, n) => {
    if (n > 0 && n % GRID_COLUMNS === 0) {
      x = 0
      y += rowH + GAP
      rowH = 0
    }
    let cy = y
    let colW = 0
    for (const ix of column) {
      origins[ix] = [x, cy]
      cy += bs[ix]!.h + GAP / 2
      colW = Math.max(colW, bs[ix]!.w)
    }
    rowH = Math.max(rowH, cy - GAP / 2 - y)
    x += colW + GAP
  })
  return origins
}

/**
 * A mind map: the root in the middle, first-level branches alternating right and left (the first
 * half right), deeper levels outward, every subtree centered on its parent. Blocks the tree
 * doesn't reach go in a row under it.
 */
function tree(
  bs: readonly Block[],
  items: readonly LayoutItem[],
  links: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const n = bs.length
  const origins: Array<[number, number]> = bs.map(() => [0, 0])
  if (n === 0) return origins
  const topic = (ix: number): boolean => items.some((i) => i.id === bs[ix]!.id && i.topic)
  const hasIncoming = new Set(links.map(([, t]) => t))
  let root = -1
  for (let ix = 0; ix < n && root < 0; ix++) if (topic(ix)) root = ix
  for (let ix = 0; ix < n && root < 0; ix++) if (!hasIncoming.has(ix)) root = ix
  if (root < 0) root = 0

  // Breadth-first tree over the links, either direction.
  const adjacent: number[][] = bs.map(() => [])
  for (const [s, t] of links) {
    adjacent[s]!.push(t)
    adjacent[t]!.push(s)
  }
  const children: number[][] = bs.map(() => [])
  const seen = bs.map(() => false)
  seen[root] = true
  const queue = [root]
  while (queue.length > 0) {
    const ix = queue.shift()!
    for (const next of adjacent[ix]!) {
      if (!seen[next]) {
        seen[next] = true
        children[ix]!.push(next)
        queue.push(next)
      }
    }
  }

  const span = (ix: number): number => {
    const kids =
      children[ix]!.reduce((sum, c) => sum + span(c), 0) +
      INNER_GAP * 2 * Math.max(children[ix]!.length - 1, 0)
    return Math.max(bs[ix]!.h, kids)
  }
  /** Places the children of `ix` (whose origin is set) on one side, `dir` 1 right, -1 left. */
  const branch = (ix: number, kids: readonly number[], dir: number): void => {
    if (kids.length === 0) return
    const total = kids.reduce((sum, c) => sum + span(c), 0) + INNER_GAP * 2 * (kids.length - 1)
    const center = origins[ix]![1] + bs[ix]!.h / 2
    let y = center - total / 2
    for (const kid of kids) {
      const s = span(kid)
      const x =
        dir > 0 ? origins[ix]![0] + bs[ix]!.w + RANK_GAP : origins[ix]![0] - RANK_GAP - bs[kid]!.w
      origins[kid] = [x, y + s / 2 - bs[kid]!.h / 2]
      branch(kid, children[kid]!, dir)
      y += s + INNER_GAP * 2
    }
  }
  const first = children[root]!
  const rightCount = Math.ceil(first.length / 2)
  branch(root, first.slice(0, rightCount), 1)
  branch(root, first.slice(rightCount), -1)

  // Anything unreached sits in a row under the tree.
  let bottom = -Number.MAX_VALUE
  let leftEdge = Number.MAX_VALUE
  for (let ix = 0; ix < n; ix++) {
    if (!seen[ix]) continue
    bottom = Math.max(bottom, origins[ix]![1] + bs[ix]!.h)
    leftEdge = Math.min(leftEdge, origins[ix]![0])
  }
  let x = leftEdge
  for (let ix = 0; ix < n; ix++) {
    if (seen[ix]) continue
    origins[ix] = [x, bottom + GAP]
    x += bs[ix]!.w + GAP
  }
  return origins
}

/**
 * Layers left to right: a block's layer is the longest path to it from a block nothing points to
 * (cycles broken where met). Each layer is a column stacked top to bottom, ordered by the average
 * position of its predecessors, and centered on the tallest layer.
 */
function flow(
  bs: readonly Block[],
  links: ReadonlyArray<readonly [number, number]>,
): Array<[number, number]> {
  const n = bs.length
  const indegree = new Array<number>(n).fill(0)
  const out: number[][] = bs.map(() => [])
  for (const [s, t] of links) {
    out[s]!.push(t)
    indegree[t]! += 1
  }
  // Kahn's order; whatever a cycle leaves behind joins in item order.
  const layer = new Array<number>(n).fill(0)
  const queue: number[] = []
  for (let ix = 0; ix < n; ix++) if (indegree[ix] === 0) queue.push(ix)
  const done = new Array<boolean>(n).fill(false)
  const remaining = [...indegree]
  for (;;) {
    while (queue.length > 0) {
      const ix = queue.shift()!
      if (done[ix]) continue
      done[ix] = true
      for (const t of out[ix]!) {
        layer[t] = Math.max(layer[t]!, layer[ix]! + 1)
        remaining[t] = Math.max(remaining[t]! - 1, 0)
        if (remaining[t] === 0) queue.push(t)
      }
    }
    const next = done.indexOf(false)
    if (next < 0) break
    queue.push(next)
  }

  const layers = n === 0 ? 0 : Math.max(...layer) + 1
  const columns: number[][] = Array.from({ length: layers }, () => [])
  for (let ix = 0; ix < n; ix++) columns[layer[ix]!]!.push(ix)
  const origins: Array<[number, number]> = bs.map(() => [0, 0])
  let x = 0
  for (const column of columns) {
    // Order by where the predecessors already sit.
    const keys = new Map<number, number>()
    for (const ix of column) {
      const ys = links.filter(([, t]) => t === ix).map(([s]) => origins[s]![1] + bs[s]!.h / 2)
      keys.set(ix, ys.length === 0 ? Number.MAX_VALUE : ys.reduce((a, b) => a + b, 0) / ys.length)
    }
    column.sort((a, b) => keys.get(a)! - keys.get(b)! || a - b)
    const height =
      column.reduce((sum, ix) => sum + bs[ix]!.h, 0) + GAP * Math.max(column.length - 1, 0)
    let y = -height / 2
    const width = column.reduce((m, ix) => Math.max(m, bs[ix]!.w), 0)
    for (const ix of column) {
      origins[ix] = [x, y]
      y += bs[ix]!.h + GAP
    }
    x += width + RANK_GAP
  }
  return origins
}
