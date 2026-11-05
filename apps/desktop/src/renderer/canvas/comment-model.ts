/**
 * Comment pins on the Canvas page, as a live room draws them (canvas-live `threads.ts`, the room
 * page's `pins.tsx`): where a new pin goes, where a saved one sits, and the short labels. No DOM,
 * so tests call these directly.
 */
import type { CanvasThread } from '@evaos/contract'

/** A card's box in board space. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A pin's tip, or its card's corner: the key (`/`) and the Comment button put the pin there. */
export const CORNER = { right: 28, top: 18 } as const

/** Where a pin goes: with `node`, `x`/`y` are an offset from that card's top left. */
export interface Anchor {
  node?: string
  x: number
  y: number
}

const inside = (b: Box, p: { x: number; y: number }): boolean =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h

/**
 * The anchor for a comment made at board point `at`: on `node` at that spot when it falls inside
 * the card, else at the card's top right corner; with no card, the point itself.
 */
export function anchorFor(
  at: { x: number; y: number } | null,
  node: { id: string; box: Box } | null,
): Anchor {
  if (node === null) return { x: at?.x ?? 0, y: at?.y ?? 0 }
  const { box } = node
  if (at !== null && inside(box, at)) return { node: node.id, x: at.x - box.x, y: at.y - box.y }
  return { node: node.id, x: box.w - CORNER.right, y: CORNER.top }
}

/** The topmost card of `boxes` (later wins) holding `at`. */
export function nodeAt(
  at: { x: number; y: number },
  boxes: ReadonlyMap<string, Box>,
): { id: string; box: Box } | null {
  let found: { id: string; box: Box } | null = null
  for (const [id, box] of boxes) if (inside(box, at)) found = { id, box }
  return found
}

/** Where the pin's tip is on the board; null when its card is gone. */
export function pinPoint(
  thread: Pick<CanvasThread, 'node' | 'x' | 'y'>,
  boxes: ReadonlyMap<string, Box>,
): { x: number; y: number } | null {
  if (thread.node === undefined) return { x: thread.x, y: thread.y }
  const box = boxes.get(thread.node)
  return box ? { x: box.x + thread.x, y: box.y + thread.y } : null
}

/** One line of `text`, at most `max` characters. */
export function excerpt(text: string, max = 90): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** "now", "5m", "2h", "3d" since `ts`. */
export function ago(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

/** Whether the thread is waiting on an answer: a human wrote last, and it is still open. */
export function awaitingAnswer(thread: Pick<CanvasThread, 'resolved' | 'messages'>): boolean {
  return !thread.resolved && thread.messages.at(-1)?.kind === 'human'
}
