/**
 * Board file <-> React Flow. The file keeps absolute top-left positions and its own node order;
 * React Flow wants positions relative to a parent frame and parents before their children, so
 * each node carries its file rank and conversions go through absolute positions.
 */
import type { Edge, Node } from '@xyflow/react'
import type {
  CanvasBoard,
  CanvasEdge,
  CanvasLayout,
  CanvasNode,
  CanvasViewport,
} from '@evaos/contract'
import { CANVAS_VERSION } from '@evaos/contract'
import { FRAME_DEFAULT_H, defaultWidth, edgeTone, roundHalfAway } from './board-model'
import type { Point } from './layout'

export type CardData = {
  /** The node as its file says it; x and y live on the React Flow node. */
  spec: CanvasNode
  /** File order, kept through saves. */
  rank: number
  /** A frame holding nodes (no wireframe then). */
  hasChildren: boolean
}
export type CardNode = Node<CardData, 'card'>

export type LinkData = {
  label?: string
  tone?: 'accent' | 'proposed'
}
export type LinkEdge = Edge<LinkData, 'link'>

/** A board's state minus the viewport: what undo restores and autosave compares. */
export interface BoardDoc {
  title: string
  layout: CanvasLayout | undefined
  nodes: CardNode[]
  edges: LinkEdge[]
}

/** Frame ids that are a valid parent of `spec` (an existing frame, no cycle). */
function parentOf(spec: CanvasNode, byId: ReadonlyMap<string, CanvasNode>): string | undefined {
  const p = spec.parent
  if (p === undefined || p === spec.id || byId.get(p)?.type !== 'frame') return undefined
  // Walk up: a frame chain that loops back to this node is broken here.
  const seen = new Set([spec.id])
  let cur: string | undefined = p
  while (cur !== undefined) {
    if (seen.has(cur)) return undefined
    seen.add(cur)
    const up: CanvasNode | undefined = byId.get(cur)
    cur = up?.parent !== undefined && byId.get(up.parent)?.type === 'frame' ? up.parent : undefined
  }
  return p
}

/**
 * React Flow nodes for file nodes at absolute `at` positions (missing ones at the origin),
 * parents first. `selected` ids stay selected.
 */
export function toFlowNodes(
  specs: readonly CanvasNode[],
  at: ReadonlyMap<string, Point>,
  selected: ReadonlySet<string> = new Set(),
): CardNode[] {
  const byId = new Map(specs.map((s) => [s.id, s]))
  const parent = new Map<string, string>()
  for (const s of specs) {
    const p = parentOf(s, byId)
    if (p !== undefined) parent.set(s.id, p)
  }
  const withChildren = new Set(parent.values())
  const depth = (id: string): number => {
    let d = 0
    for (let p = parent.get(id); p !== undefined; p = parent.get(p)) d += 1
    return d
  }
  const ranked = specs.map((spec, rank) => ({ spec, rank, depth: depth(spec.id) }))
  ranked.sort((a, b) => a.depth - b.depth || a.rank - b.rank)
  return ranked.map(({ spec, rank }) => {
    const [x, y] = at.get(spec.id) ?? [0, 0]
    const p = parent.get(spec.id)
    const [px, py] = p !== undefined ? (at.get(p) ?? [0, 0]) : [0, 0]
    const frame = spec.type === 'frame'
    const { x: _x, y: _y, ...rest } = spec
    const node: CardNode = {
      id: spec.id,
      type: 'card',
      position: { x: x - px, y: y - py },
      data: { spec: rest, rank, hasChildren: withChildren.has(spec.id) },
      width: spec.w ?? defaultWidth(spec.type),
      selected: selected.has(spec.id),
      zIndex: frame ? -1 : 0,
    }
    if (frame) node.height = spec.h ?? FRAME_DEFAULT_H
    else if (spec.h !== undefined) node.height = spec.h
    if (p !== undefined) {
      node.parentId = p
      node.expandParent = true
    }
    return node
  })
}

export function toFlowEdges(edges: readonly CanvasEdge[]): LinkEdge[] {
  return edges.map((e) => {
    const edge: LinkEdge = { id: e.id, source: e.source, target: e.target, type: 'link', data: {} }
    if (e.sourceHandle !== undefined) edge.sourceHandle = e.sourceHandle
    if (e.targetHandle !== undefined) edge.targetHandle = e.targetHandle
    if (e.label !== undefined) edge.data!.label = e.label
    const tone = edgeTone(e.tone)
    if (tone) edge.data!.tone = tone
    return edge
  })
}

/** Absolute top-left positions of every node. */
export function absolutePositions(nodes: readonly CardNode[]): Map<string, Point> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Map<string, Point>()
  const abs = (n: CardNode, guard: number): Point => {
    const done = out.get(n.id)
    if (done) return done
    const p = n.parentId !== undefined ? byId.get(n.parentId) : undefined
    const [px, py] = p && guard < 64 ? abs(p, guard + 1) : [0, 0]
    const at: Point = [n.position.x + px, n.position.y + py]
    out.set(n.id, at)
    return at
  }
  for (const n of nodes) abs(n, 0)
  return out
}

/** The file node for a React Flow node at absolute `at`, positions rounded like native. */
function fileNode(n: CardNode, at: Point): CanvasNode {
  const spec = n.data.spec
  let { w, h } = spec
  if (spec.type === 'frame') {
    // Frames keep the size the layout or a growing child gave them.
    if (n.width !== undefined && (w !== undefined || n.width !== defaultWidth('frame')))
      w = roundHalfAway(n.width)
    if (n.height !== undefined && (h !== undefined || n.height !== FRAME_DEFAULT_H))
      h = roundHalfAway(n.height)
  } else if (spec.type === 'ui' || spec.type === 'proto') {
    // A live widget or prototype keeps the size its resize handles gave it.
    if (n.width !== undefined && (w !== undefined || n.width !== defaultWidth(spec.type)))
      w = roundHalfAway(n.width)
    if (n.height !== undefined) h = roundHalfAway(n.height)
  }
  const out: CanvasNode = { id: spec.id, type: spec.type }
  out.x = roundHalfAway(at[0])
  out.y = roundHalfAway(at[1])
  if (w !== undefined) out.w = w
  if (h !== undefined) out.h = h
  if (spec.parent !== undefined) out.parent = spec.parent
  if (spec.data !== undefined) out.data = spec.data
  return out
}

function fileEdge(e: LinkEdge): CanvasEdge {
  const out: CanvasEdge = { id: e.id, source: e.source, target: e.target }
  if (e.sourceHandle) out.sourceHandle = e.sourceHandle
  if (e.targetHandle) out.targetHandle = e.targetHandle
  if (e.data?.label !== undefined) out.label = e.data.label
  if (e.data?.tone !== undefined) out.tone = e.data.tone
  return out
}

/** The board as its file says it (canvas_view.rs to_file). */
export function toBoard(doc: BoardDoc, viewport: CanvasViewport | null): CanvasBoard {
  const at = absolutePositions(doc.nodes)
  const nodes = [...doc.nodes]
    .sort((a, b) => a.data.rank - b.data.rank)
    .map((n) => fileNode(n, at.get(n.id) ?? [0, 0]))
  const board: CanvasBoard = {
    version: CANVAS_VERSION,
    title: doc.title,
    ...(doc.layout !== undefined ? { layout: doc.layout } : {}),
    nodes,
    edges: doc.edges.map(fileEdge),
  }
  if (viewport) {
    board.viewport = {
      x: roundHalfAway(viewport.x),
      y: roundHalfAway(viewport.y),
      zoom: roundHalfAway(viewport.zoom * 100) / 100,
    }
  }
  return board
}
