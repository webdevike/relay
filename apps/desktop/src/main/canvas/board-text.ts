import {
  CANVAS_NODE_KINDS,
  CanvasEdgeSchema,
  CanvasNodeDataSchema,
  CanvasNodeSchema,
  type CanvasBoard,
  type CanvasNode,
} from '@evaos/contract'
import {
  BoardError,
  parseBoard as liveParseBoard,
  type Board,
  type BoardEdge,
  type BoardNode,
} from '@relay/canvas-live/board'
import { FIRST_PAGE, FIRST_PAGE_TITLE } from '@relay/canvas-live/pages'

/** Byte for byte what native EvaOS and Relay's live rooms write for the same board. */
export { boardText } from '@relay/canvas-live/board'

export function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * The board file as Relay's live rooms read it (@relay/canvas-live/board, native `board::parse`
 * plus Relay's own fields: comment `threads` and `pages`). A newer `version` or a bad file throws
 * `invalid-data`.
 */
export function parseBoard(text: string): Board {
  try {
    return liveParseBoard(text)
  } catch (e) {
    if (e instanceof BoardError) throw coded(e.message, 'invalid-data')
    throw e
  }
}

/**
 * Contract fields @relay/canvas-live does not know: it keeps them as unknown keys (`extra`) of
 * the node, its data or the edge. The page shows them as fields and a save puts them back there,
 * so the file keeps them where an older writer keeps unknown keys too.
 */
const NODE_FIELDS = { pinned: CanvasNodeSchema.shape.pinned } as const
const DATA_FIELDS = {
  icon: CanvasNodeDataSchema.shape.icon,
  step: CanvasNodeDataSchema.shape.step,
  why: CanvasNodeDataSchema.shape.why,
  mermaid: CanvasNodeDataSchema.shape.mermaid,
  variant: CanvasNodeDataSchema.shape.variant,
} as const
const EDGE_FIELDS = { route: CanvasEdgeSchema.shape.route } as const

type Fields = Readonly<Record<string, { safeParse(v: unknown): { success: boolean } }>>

/** `extra` split: the valid `fields` it holds, and the keys left. */
function split(
  extra: Record<string, unknown> | undefined,
  fields: Fields,
): { lifted: Record<string, unknown>; left: Record<string, unknown> | undefined } {
  const lifted: Record<string, unknown> = {}
  const left: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (Object.hasOwn(fields, k) && fields[k]!.safeParse(v).success) lifted[k] = v
    else left[k] = v
  }
  return { lifted, left: Object.keys(left).length > 0 ? left : undefined }
}

/** `o` with the valid `fields` of its `extra` as its own keys. */
function lift<T extends { extra?: Record<string, unknown> | undefined }>(o: T, fields: Fields): T {
  const { lifted, left } = split(o.extra, fields)
  if (Object.keys(lifted).length === 0) return o
  const { extra: _extra, ...rest } = o
  return { ...rest, ...(left ? { extra: left } : {}), ...lifted } as T
}

/**
 * `o` as canvas-live writes it: its `fields` moved into `extra`, after the other unknown keys
 * `was` (the file's `extra`) has.
 */
function lower(
  o: object,
  was: Record<string, unknown> | undefined,
  fields: Fields,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const extra: Record<string, unknown> = { ...split(was, fields).left }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'extra') continue
    if (Object.hasOwn(fields, k)) {
      if (v !== undefined) extra[k] = v
    } else out[k] = v
  }
  if (Object.keys(extra).length > 0) out.extra = extra
  return out
}

/** A node of the file as the page shows it: pins and the new data fields as fields. */
function shownNode(n: BoardNode): BoardNode {
  const node = lift(n, NODE_FIELDS)
  return node.data ? { ...node, data: lift(node.data, DATA_FIELDS) } : node
}

/**
 * A node of the page as the file keeps it: over the file's node `was` (whose unknown keys are the
 * file's), else over its own.
 */
function fileNode(n: BoardNode, was: BoardNode | undefined): BoardNode {
  const out = lower(n, was ? was.extra : n.extra, NODE_FIELDS)
  const wasData = was ? was.data?.extra : n.data?.extra
  if (n.data !== undefined || wasData !== undefined) {
    out.data = lower(n.data ?? {}, wasData, DATA_FIELDS)
  }
  return out as unknown as BoardNode
}

/** The fields the Canvas page edits at board level; page content is laid over one page. */
const EDITED = ['version', 'title', 'layout'] as const

export interface PageRef {
  id: string
  title: string
}

/** Every page of the file in order (a board without `pages` has just page-1). */
export function pagesOfBoard(file: Board): PageRef[] {
  return (file.pages ?? [{ id: FIRST_PAGE, title: FIRST_PAGE_TITLE }]).map((p) => ({
    id: p.id,
    title: p.title,
  }))
}

/** Nodes of a kind the Canvas page cannot draw (a newer writer's), and the edges that touch them. */
function hiddenOf(
  nodes: BoardNode[],
  edges: BoardEdge[],
): { nodes: Set<string>; edges: Set<string> } {
  const kinds: readonly string[] = CANVAS_NODE_KINDS
  const hidden = new Set(nodes.filter((n) => !kinds.includes(n.type)).map((n) => n.id))
  const hiddenEdges = new Set(
    edges.filter((e) => hidden.has(e.source) || hidden.has(e.target)).map((e) => e.id),
  )
  return { nodes: hidden, edges: hiddenEdges }
}

/** A page's content in the file: the top level for page-1, else its entry. */
function contentOf(file: Board, page: string): { nodes: BoardNode[]; edges: BoardEdge[] } {
  if (page === FIRST_PAGE) return file
  const entry = file.pages?.find((p) => p.id === page)
  return { nodes: entry?.nodes ?? [], edges: entry?.edges ?? [] }
}

/**
 * The board as the Canvas page shows `page`: board-level title and layout plus that page's nodes,
 * edges and viewport, without nodes of kinds it cannot draw (they stay in the file, see
 * `overFile`). `page` is the one shown: the requested page when the file has it, else the first
 * in order.
 */
export function pageView(
  file: Board,
  requested: string | undefined,
): { board: CanvasBoard; pages: PageRef[]; page: string } {
  const pages = pagesOfBoard(file)
  const page = pages.find((p) => p.id === requested)?.id ?? pages[0]!.id
  const { nodes, edges } = contentOf(file, page)
  const hidden = hiddenOf(nodes, edges)
  const viewport =
    page === FIRST_PAGE ? file.viewport : file.pages?.find((p) => p.id === page)?.viewport
  const shown = nodes.filter((n) => !hidden.nodes.has(n.id)).map(shownNode) as CanvasNode[]
  return {
    board: {
      version: file.version,
      title: file.title,
      ...(file.layout ? { layout: file.layout } : {}),
      nodes: shown,
      edges: edges.filter((e) => !hidden.edges.has(e.id)).map((e) => lift(e, EDGE_FIELDS)),
      ...(viewport ? { viewport } : {}),
    },
    pages,
    page,
  }
}

/**
 * The page's nodes and edges as the Canvas page saved them, with what it never saw put back from
 * the file: nodes of kinds it cannot draw and their edges (at their places in the list), and the
 * keys Relay does not know on every node, its data and every edge (`extra`, which also holds the
 * contract fields canvas-live does not know).
 */
function keepUnseen(
  saved: { nodes: BoardNode[]; edges: BoardEdge[] },
  file: { nodes: BoardNode[]; edges: BoardEdge[] },
): { nodes: BoardNode[]; edges: BoardEdge[] } {
  const hidden = hiddenOf(file.nodes, file.edges)
  const fileNodes = new Map(file.nodes.map((n) => [n.id, n]))
  const fileEdges = new Map(file.edges.map((e) => [e.id, e]))
  const nodes = saved.nodes.map((n) => fileNode(n, fileNodes.get(n.id)))
  const edges = saved.edges.map((e): BoardEdge => {
    const was = fileEdges.get(e.id)
    return lower(e, was ? was.extra : e.extra, EDGE_FIELDS) as unknown as BoardEdge
  })
  file.nodes.forEach((n, i) => {
    if (hidden.nodes.has(n.id)) nodes.splice(Math.min(i, nodes.length), 0, n)
  })
  file.edges.forEach((e, i) => {
    if (hidden.edges.has(e.id) && !edges.some((s) => s.id === e.id))
      edges.splice(Math.min(i, edges.length), 0, e)
  })
  return { nodes, edges }
}

/**
 * The Canvas page's board laid over the file it came from, so a save keeps what the page does
 * not show (a live room's comment threads, the other pages, nodes of kinds it cannot draw, keys
 * Relay does not know). The board's nodes, edges and viewport go to `page` (page-1: the top
 * level). No file: the page's board as it is. A page the file does not have throws `not-found`.
 */
export function overFile(board: CanvasBoard, file: Board | null, page: string = FIRST_PAGE): Board {
  if (file === null && page !== FIRST_PAGE) throw coded(`No page ${page}.`, 'not-found')
  const out: Record<string, unknown> = { ...file }
  for (const k of EDITED) {
    if (board[k] === undefined) delete out[k]
    else out[k] = board[k]
  }
  const content = keepUnseen(
    board,
    file === null ? { nodes: [], edges: [] } : contentOf(file, page),
  )
  if (page === FIRST_PAGE) {
    out.nodes = content.nodes
    out.edges = content.edges
    if (board.viewport === undefined) delete out.viewport
    else out.viewport = board.viewport
    return out as unknown as Board
  }
  const pages = file?.pages
  if (!pages?.some((p) => p.id === page)) throw coded(`No page ${page}.`, 'not-found')
  out.pages = pages.map((p) => {
    if (p.id !== page) return p
    const { viewport: _v, ...rest } = p
    return {
      ...rest,
      nodes: content.nodes,
      edges: content.edges,
      ...(board.viewport ? { viewport: board.viewport } : {}),
    }
  })
  return out as unknown as Board
}
