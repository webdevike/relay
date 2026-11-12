/**
 * The boards mounted in this window, for main's canvas drive (internal `@canvas` call): each open
 * board registers a driver for its slug and page, and a call goes to the one Isaac sees. A board
 * that isn't on screen answers `mounted: false`, so main skips the waits and only writes the file;
 * saving pending edits (`flush`) and hiding the cursor reach every mounted board of the slug, seen
 * or not, so a board shown again later has no stale cursor.
 */
import type { CanvasBoardAnswer, CanvasBoardCall, CanvasCursorOp } from '@evaos/contract'
import type { Box } from '../comment-model'
import { unionBox, type Point, type Viewport } from './cursor-model'

type ViewCall = Extract<CanvasBoardCall, { op: 'view' }>

/** What one mounted board does for the agent. */
export interface BoardDriver {
  slug: string
  page: string
  /** The board is laid out on screen (its workspace and tab in front). */
  shown: () => boolean
  /** Draws a cursor step; answers its ms on screen. */
  cursor: (op: CanvasCursorOp) => number
  /** Saves pending local edits now. */
  flush: () => Promise<void>
  /** Every card's absolute box as drawn. */
  boxes: () => ReadonlyMap<string, Box>
  select: (ids: readonly string[]) => void
  /** Animates the viewport; resolves with where it ended. */
  view: (call: Omit<ViewCall, 'op' | 'slug' | 'page'>) => Promise<Viewport>
  /**
   * Pans (and zooms if it must) so flow box `need` shows clear of the chrome, `want` (around it)
   * too when it fits readably; answers the ms it takes.
   */
  reveal: (need: Box, want: Box | null) => number
  /** Carries card `node` to absolute top left `to` over `ms`; answers the ms it takes. */
  drag: (node: string, to: Point, ms: number) => number
  /** The carry of card `node` is in the file: it stays where it is. */
  landed: (node: string) => void
  /** Switches the board to page `page` (saving this one first). */
  goTo: (page: string) => void
}

const drivers = new Set<BoardDriver>()

/** Registers a mounted board; the returned function unregisters it. */
export function registerBoardDriver(driver: BoardDriver): () => void {
  drivers.add(driver)
  return () => drivers.delete(driver)
}

/** The board on screen showing `slug` at `page`; the latest mounted wins when several are. */
function shownBoard(
  all: Iterable<BoardDriver>,
  slug: string,
  page: string,
): BoardDriver | undefined {
  let found: BoardDriver | undefined
  for (const d of all) if (d.slug === slug && d.page === page && d.shown()) found = d
  return found
}

/** Answers one of main's board calls against `all` (the mounted boards; a test seam). */
export async function canvasBoardCall(
  call: CanvasBoardCall,
  all: Iterable<BoardDriver> = drivers,
): Promise<CanvasBoardAnswer> {
  if (call.op === 'flush') {
    const mine = [...all].filter((d) => d.slug === call.slug)
    await Promise.all(mine.map((d) => d.flush()))
    return { mounted: mine.length > 0 }
  }
  if (call.op === 'cursor' && call.cursor.op === 'hide') {
    let ms = 0
    let seen = false
    for (const d of all) {
      if (d.slug !== call.slug) continue
      const took = d.cursor(call.cursor)
      if (d.page === call.page && d.shown()) {
        seen = true
        ms = took
      }
    }
    return { mounted: seen, ms }
  }
  if (call.op === 'landed') {
    const mine = [...all].filter((d) => d.slug === call.slug)
    for (const d of mine) d.landed(call.node)
    return { mounted: mine.length > 0 }
  }
  if (call.op === 'page') {
    let front: BoardDriver | undefined
    for (const d of all) if (d.slug === call.slug && d.shown()) front = d
    if (!front) return { mounted: false, ms: 0 }
    if (front.page === call.page) return { mounted: true }
    front.goTo(call.page)
    return { mounted: false, ms: 0 }
  }
  const board = shownBoard(all, call.slug, call.page)
  if (!board) return { mounted: false, ms: 0 }
  switch (call.op) {
    case 'cursor':
      return { mounted: true, ms: board.cursor(call.cursor) }
    case 'boxes':
      return { mounted: true, boxes: Object.fromEntries(board.boxes()) }
    case 'select':
      board.select(call.ids)
      return { mounted: true }
    case 'view': {
      const { op: _op, slug: _slug, page: _page, ...want } = call
      return { mounted: true, viewport: await board.view(want) }
    }
    case 'drag':
      return { mounted: true, ms: board.drag(call.node, call.to, call.ms) }
    case 'reveal': {
      const drawn = board.boxes()
      const boxes = (call.nodes ?? []).flatMap((id) => drawn.get(id) ?? [])
      if (call.box) boxes.push(call.box)
      const need = unionBox(boxes)
      if (!need) return { mounted: true, ms: 0 }
      const around = (call.context ?? []).flatMap((id) => drawn.get(id) ?? [])
      if (call.around) around.push(call.around)
      const want = around.length > 0 ? unionBox([need, ...around]) : null
      return { mounted: true, ms: board.reveal(need, want) }
    }
  }
}
