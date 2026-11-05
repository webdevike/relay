import type { CanvasBoard } from '@evaos/contract'
import { BoardError, parseBoard as liveParseBoard, type Board } from '@relay/canvas-live/board'

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

/** The fields the Canvas page edits; everything else in the file (threads, pages) it never sees. */
const EDITED = ['version', 'title', 'layout', 'nodes', 'edges', 'viewport'] as const

/**
 * The Canvas page's board laid over the file it came from, so a save keeps what the page does
 * not show (a live room's comment threads, other pages). No file: the page's board as it is.
 */
export function overFile(board: CanvasBoard, file: Board | null): Board {
  const out: Record<string, unknown> = { ...file }
  for (const k of EDITED) {
    if (board[k] === undefined) delete out[k]
    else out[k] = board[k]
  }
  return out as unknown as Board
}
