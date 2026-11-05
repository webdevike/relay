/**
 * The switch from the Canvas page's own board to a live room on it, without Isaac seeing a reload:
 * the room's frame loads behind the board, is handed the board's page, view, selection and open
 * thread (`@relay/canvas-live/carry`), and only once it says it shows exactly that is it swapped in
 * and the board dropped. No DOM or React here, so tests call these directly.
 */
import type { Carry } from '@relay/canvas-live/carry'

/** What the board shows right now, for the room to open on. */
export function carryOf(view: {
  page: string
  viewport: { x: number; y: number; zoom: number } | null
  nodes: readonly { id: string; selected?: boolean | undefined }[]
  thread: string | null
}): Carry {
  return {
    page: view.page,
    viewport: view.viewport === null ? null : { ...view.viewport },
    selection: view.nodes.filter((n) => n.selected === true).map((n) => n.id),
    thread: view.thread,
  }
}

/** The mounted board's reader: the room asks it for the carry when its frame says it is ready. */
let reader: { slug: string; read: () => Carry } | null = null

/** Registers the board on `slug` as the one a room takes over; returns how it unregisters. */
export function registerBoardCarry(slug: string, read: () => Carry): () => void {
  const mine = { slug, read }
  reader = mine
  return () => {
    if (reader === mine) reader = null
  }
}

/** What the board on `slug` shows now; null when no board of it is mounted. */
export function readBoardCarry(slug: string): Carry | null {
  return reader?.slug === slug ? reader.read() : null
}

export interface Layers {
  /** The board is drawn. */
  board: boolean
  /** The room's frame is drawn (mounted). */
  live: boolean
  /** The frame is mounted but still behind the board: invisible, inert, loading. */
  covered: boolean
}

/**
 * Which of the board and the room are on the page. The room replaces a board that was on screen
 * only once `positioned` names it; a room that opens with no board before it (a link, a restart)
 * simply shows.
 */
export function layersFor(input: {
  slug: string | null
  room: string | null
  boardWasUp: boolean
  positioned: string | null
}): Layers {
  const { slug, room, boardWasUp, positioned } = input
  if (slug === null) return { board: false, live: false, covered: false }
  if (room === null) return { board: true, live: false, covered: false }
  const covered = boardWasUp && positioned !== room
  return { board: covered, live: true, covered }
}

/** How long a room's frame may take to report it is positioned before the swap happens anyway. */
export const POSITION_TIMEOUT_MS = 5_000
