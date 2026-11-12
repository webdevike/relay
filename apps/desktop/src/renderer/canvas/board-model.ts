/**
 * Board file helpers, ported from native canvas_view/board.rs and canvas_view.rs: default widths,
 * height estimates, the layout a board uses, where reloaded nodes go and where unplaced nodes
 * are put. Pure functions over the contract's board types.
 */
import type { CanvasEdge, CanvasLayout, CanvasNode, CanvasNodeKind } from '@evaos/contract'
import { FRAME_HEADER, FRAME_PAD, place, type LayoutItem, type Point, type Size } from './layout'
import type {
  LayoutAlgorithm,
  LayoutEdge,
  LayoutNode,
  LayoutOptions,
} from '../../shared/canvas-layout/types'

/** Width when the file gives none, in flow units (board.rs Kind::default_width). */
export function defaultWidth(kind: CanvasNodeKind): number {
  switch (kind) {
    case 'note':
      return 220
    case 'frame':
      return 330
    case 'ui':
      return 420
    case 'proto':
      return 960
    case 'suggestion':
    case 'typography':
      return 260
    case 'step':
      return 300
    case 'explainer':
      return 380
    default:
      return 240
  }
}

/** A frame's height when neither the file nor the layout gave one. */
export const FRAME_DEFAULT_H = 220

const utf8 = new TextEncoder()

/** A height estimate for layout before a node has been drawn, from its width and text. */
export function estimateHeight(node: CanvasNode, width: number): number {
  if (node.h !== undefined) return node.h
  // Rust's str::len counts UTF-8 bytes.
  const lines = (text: string | undefined, pxPerChar: number): number =>
    Math.ceil(((text ? utf8.encode(text).length : 0) * pxPerChar) / Math.max(width - 28, 40))
  const d = node.data ?? {}
  switch (node.type) {
    case 'topic':
      return 84
    case 'note':
      return 52 + lines(d.body, 6.6) * 18
    case 'ticket':
      return 110
    case 'image':
      return width * 0.75 + 28 + lines(d.title, 7) * 18 + lines(d.caption, 6) * 16
    case 'link':
      return 64 + lines(d.caption, 6) * 16
    case 'step': {
      const perLine = Math.max(10, (44 * (width - 28)) / 272)
      const body = (d.body ?? '')
        .split('\n')
        .reduce((n, l) => (l.trim() === '' ? n : n + Math.ceil(l.length / perLine)), 0)
      return 64 + body * 18
    }
    case 'explainer': {
      const perLine = Math.max(10, (52 * (width - 28)) / 352)
      const wrapped = (text: string | undefined): number =>
        (text ?? '')
          .split('\n')
          .reduce((n, l) => (l.trim() === '' ? n : n + Math.ceil(l.length / perLine)), 0)
      return (
        56 +
        wrapped(d.body) * 20 +
        (d.src !== undefined ? 168 : 0) +
        (d.mermaid !== undefined ? 228 : 0) +
        (d.why !== undefined ? 36 + wrapped(d.why) * 20 : 0)
      )
    }
    case 'frame':
      return FRAME_DEFAULT_H
    case 'suggestion':
      return 76 + lines(d.body, 6.6) * 18
    case 'palette':
      return 60 + Math.max(Math.ceil((d.colors?.length ?? 0) / 4), 1) * 72
    case 'typography':
      return 150 + lines(d.sample, 7) * 20
    case 'ui':
      return 320
    case 'proto':
      return 640
  }
}

/**
 * The layout a board uses when its file names none: grid with frames, tree with a topic and
 * links, flow with links, else grid.
 */
export function effectiveLayout(
  fileLayout: CanvasLayout | undefined,
  nodes: readonly CanvasNode[],
  hasEdges: boolean,
): CanvasLayout {
  if (fileLayout) return fileLayout
  if (nodes.some((n) => n.type === 'frame')) return 'grid'
  if (hasEdges && nodes.some((n) => n.type === 'topic')) return 'tree'
  if (hasEdges) return 'flow'
  return 'grid'
}

/**
 * Layout inputs: measured sizes where a node has been drawn, else the file's size or an estimate.
 * Frames take their file size (the layout grows them around children).
 */
export function layoutItems(
  nodes: readonly CanvasNode[],
  measured: ReadonlyMap<string, Size>,
): LayoutItem[] {
  return nodes.map((n) => {
    const drawn = n.type === 'frame' ? undefined : measured.get(n.id)
    const w = n.w ?? defaultWidth(n.type)
    const [iw, ih] = drawn ?? [w, estimateHeight(n, w)]
    return {
      id: n.id,
      w: iw,
      h: ih,
      frame: n.type === 'frame',
      parent: n.parent ?? null,
      topic: n.type === 'topic',
    }
  })
}

/** (source, target) pairs the layout follows. */
export const edgePairs = (
  edges: ReadonlyArray<{ source: string; target: string }>,
): Array<[string, string]> => edges.map((e) => [e.source, e.target])

/**
 * Where each node of a reloaded board goes: its position in the file, else where the board
 * already had it (an external writer that leaves positions out doesn't scramble the board), else
 * null for auto-layout.
 */
export function reloadPositions(
  incoming: readonly CanvasNode[],
  current: ReadonlyMap<string, Point>,
): Array<[string, Point | null]> {
  return incoming.map((n) => {
    if (n.x !== undefined && n.y !== undefined) return [n.id, [n.x, n.y]]
    return [n.id, current.get(n.id) ?? null]
  })
}

export interface PlaceResult {
  positions: Map<string, Point>
  /** Sizes the layout chose for frames; callers write them into the specs, rounded. */
  frameSizes: Map<string, Size>
}

/**
 * Positions for the `unplaced` nodes. When nothing is placed the whole board is laid out;
 * otherwise a node joining a placed frame goes under its siblings (the frame grows), and the rest
 * are laid out together to the right of what is there.
 */
export function placeUnplaced(args: {
  layout: CanvasLayout
  nodes: readonly CanvasNode[]
  edges: readonly CanvasEdge[]
  /** Absolute positions of the placed nodes. */
  placed: ReadonlyMap<string, Point>
  measured: ReadonlyMap<string, Size>
  unplaced: readonly string[]
}): PlaceResult {
  const { layout, nodes, edges, placed, measured, unplaced } = args
  const positions = new Map<string, Point>()
  const frameSizes = new Map<string, Size>()
  if (unplaced.length === 0) return { positions, frameSizes }
  const pairs = edgePairs(edges)
  const items = layoutItems(nodes, measured)
  const isUnplaced = new Set(unplaced)
  if (unplaced.length === nodes.length) return place(layout, items, pairs)

  const specs = new Map(nodes.map((n) => [n.id, n]))
  const itemOf = new Map(items.map((i) => [i.id, i]))
  const rect = (id: string): [number, number, number, number] | null => {
    const at = placed.get(id)
    const item = itemOf.get(id)
    const spec = specs.get(id)
    if (!at || !item || !spec) return null
    return [at[0], at[1], spec.w ?? item.w, spec.h ?? item.h]
  }
  const rest: LayoutItem[] = []
  for (const item of items) {
    if (!isUnplaced.has(item.id)) continue
    const frameId = item.parent !== null && !isUnplaced.has(item.parent) ? item.parent : null
    const frame = frameId === null ? null : rect(frameId)
    if (frameId === null || frame === null) {
      rest.push(item)
      continue
    }
    const [fx, fy, fw, fh] = frame
    // Under the lowest sibling already in the frame.
    let bottom = fy + FRAME_HEADER
    for (const s of items) {
      if (s.parent !== frameId || s.id === item.id) continue
      const done = positions.get(s.id)
      if (done) bottom = Math.max(bottom, done[1] + s.h)
      else if (!isUnplaced.has(s.id)) {
        const r = rect(s.id)
        if (r) bottom = Math.max(bottom, r[1] + r[3])
      }
    }
    const at: Point = [fx + FRAME_PAD, bottom + FRAME_PAD]
    positions.set(item.id, at)
    const grown = frameSizes.get(frameId) ?? [fw, fh]
    frameSizes.set(frameId, [
      Math.max(grown[0], item.w + FRAME_PAD * 2),
      Math.max(grown[1], at[1] + item.h + FRAME_PAD - fy),
    ])
  }
  if (rest.length > 0) {
    let right = 0
    let top = Number.MAX_VALUE
    for (const n of nodes) {
      if (isUnplaced.has(n.id)) continue
      const r = rect(n.id)
      if (r) right = Math.max(right, r[0] + r[2])
      const at = placed.get(n.id)
      if (at) top = Math.min(top, at[1])
    }
    if (top === Number.MAX_VALUE) top = 0
    const placement = place(layout, rest, pairs)
    for (const [id, [x, y]] of placement.positions) positions.set(id, [right + 120 + x, top + y])
    for (const [id, size] of placement.frameSizes) frameSizes.set(id, size)
  }
  return { positions, frameSizes }
}

/** The gap between cards the layout engine leaves (canvas.layout's default too). */
export const LAYOUT_SPACING = 56

/**
 * The layout engine's options for a board laid out whole (opened with no positions, Tidy): flow
 * boards as layered flows left to right, trees as a tree (radial around a topic), grids as grids.
 */
export function engineOptions(
  layout: CanvasLayout,
  nodes: readonly CanvasNode[],
  keepPinned: boolean,
): LayoutOptions {
  const algorithm: LayoutAlgorithm =
    layout === 'flow'
      ? 'layered'
      : layout === 'grid'
        ? 'grid'
        : nodes.some((n) => n.type === 'topic')
          ? 'radial'
          : 'mrtree'
  return { algorithm, direction: 'right', spacing: LAYOUT_SPACING, keepPinned, only: null }
}

/**
 * The board as the layout engine takes it: each card at absolute `at` with its drawn size
 * (`measured`, else the file's or an estimate), its frame, lanes and pins, and every link
 * between two of its cards.
 */
export function engineGraph(
  nodes: readonly CanvasNode[],
  edges: ReadonlyArray<{
    id: string
    source: string
    target: string
    label?: string | undefined
    tone?: string | undefined
  }>,
  at: ReadonlyMap<string, Point>,
  measured: ReadonlyMap<string, Size>,
): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const specs = new Map(nodes.map((n) => [n.id, n]))
  const items = layoutItems(nodes, measured)
  return {
    nodes: items.map((item): LayoutNode => {
      const spec = specs.get(item.id)!
      const p = at.get(item.id)
      const parent = item.parent === null ? undefined : specs.get(item.parent)
      return {
        id: item.id,
        w: item.w,
        h: item.h,
        ...(p ? { x: p[0], y: p[1] } : {}),
        ...(parent?.type === 'frame' && parent.id !== item.id ? { parent: parent.id } : {}),
        ...(item.frame ? { frame: true } : {}),
        ...(item.frame && spec.data?.variant === 'lane' ? { lane: true } : {}),
        ...(spec.pinned ? { pinned: true } : {}),
        ...(item.topic ? { topic: true } : {}),
      }
    }),
    edges: edges
      .filter((e) => specs.has(e.source) && specs.has(e.target) && e.source !== e.target)
      .map((e): LayoutEdge => ({
        id: e.id,
        source: e.source,
        target: e.target,
        ...(e.label === undefined ? {} : { label: e.label }),
        ...(e.tone === undefined ? {} : { tone: e.tone }),
      })),
  }
}

/** Rust's f32::round: halves away from zero. */
export function roundHalfAway(v: number): number {
  const r = Math.sign(v) * Math.round(Math.abs(v))
  return r === 0 ? 0 : r
}

/** The label a node shows in the minimap, header counts and toolbar copy (cards.rs title_of). */
export function titleOf(node: CanvasNode): string {
  const d = node.data ?? {}
  return d.title ?? d.key ?? d.caption ?? ''
}

/** `note-<n>` from the node count up, skipping ids in use (cards.rs add_note). */
export function nextNoteId(ids: readonly string[]): string {
  const used = new Set(ids)
  let n = ids.length + 1
  while (used.has(`note-${n}`)) n += 1
  return `note-${n}`
}

/** An edge id `<from>-<to>` that is not taken yet. */
export function edgeId(from: string, to: string, ids: readonly string[]): string {
  const used = new Set(ids)
  const base = `${from}-${to}`
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

export const EDGE_TONES = ['accent', 'proposed', 'loop', 'success', 'danger', 'muted'] as const
export type EdgeTone = (typeof EDGE_TONES)[number]

/** Edge tones a file can name; anything else draws (and saves) as the default. */
export function edgeTone(tone: string | undefined): EdgeTone | undefined {
  return EDGE_TONES.find((t) => t === tone)
}

/** Space around the board when it fits the view (Tidy, the fit button, opening). */
export const FIT_PADDING = 0.1

/**
 * The share of `bounds` (flow units) that a `width` x `height` pane shows at `viewport`: 0 when
 * the board is entirely off screen, 1 when all of it is in view.
 */
export function visibleShare(
  bounds: { x: number; y: number; width: number; height: number },
  viewport: { x: number; y: number; zoom: number },
  width: number,
  height: number,
): number {
  if (bounds.width <= 0 || bounds.height <= 0) return 1
  const left = -viewport.x / viewport.zoom
  const top = -viewport.y / viewport.zoom
  const right = left + width / viewport.zoom
  const bottom = top + height / viewport.zoom
  const w = Math.min(right, bounds.x + bounds.width) - Math.max(left, bounds.x)
  const h = Math.min(bottom, bounds.y + bounds.height) - Math.max(top, bounds.y)
  return w <= 0 || h <= 0 ? 0 : (w * h) / (bounds.width * bounds.height)
}
