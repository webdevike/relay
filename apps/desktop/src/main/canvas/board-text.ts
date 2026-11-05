import { CANVAS_NODE_KINDS, type CanvasBoard, type CanvasNode } from '@evaos/contract'
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
  const shown = nodes.filter((n): n is CanvasNode => !hidden.nodes.has(n.id))
  return {
    board: {
      version: file.version,
      title: file.title,
      ...(file.layout ? { layout: file.layout } : {}),
      nodes: shown,
      edges: edges.filter((e) => !hidden.edges.has(e.id)),
      ...(viewport ? { viewport } : {}),
    },
    pages,
    page,
  }
}

/**
 * The page's nodes and edges as the Canvas page saved them, with what it never saw put back from
 * the file: nodes of kinds it cannot draw and their edges (at their places in the list), and the
 * keys Relay does not know on every node, its data and every edge (`extra`).
 */
function keepUnseen(
  saved: { nodes: BoardNode[]; edges: BoardEdge[] },
  file: { nodes: BoardNode[]; edges: BoardEdge[] },
): { nodes: BoardNode[]; edges: BoardEdge[] } {
  const hidden = hiddenOf(file.nodes, file.edges)
  const fileNodes = new Map(file.nodes.map((n) => [n.id, n]))
  const fileEdges = new Map(file.edges.map((e) => [e.id, e]))
  const nodes = saved.nodes.map((n): BoardNode => {
    const was = fileNodes.get(n.id)
    if (was === undefined) return n
    const out: BoardNode = { ...n }
    if (was.extra) out.extra = was.extra
    if (was.data?.extra) out.data = { ...n.data, extra: was.data.extra }
    return out
  })
  const edges = saved.edges.map((e): BoardEdge => {
    const extra = fileEdges.get(e.id)?.extra
    return extra ? { ...e, extra } : e
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
  const content = file === null ? board : keepUnseen(board, contentOf(file, page))
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
