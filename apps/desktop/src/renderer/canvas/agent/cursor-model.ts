/**
 * Where the agent's cursor and view land on a board: flow coordinates (the board file's) to the
 * board overlay's screen px at the current viewport, and the viewport a `view` call animates to.
 * No DOM, so tests call these directly.
 */
import type { CanvasCursorOp } from '@evaos/contract'
import type { Box } from '../comment-model'

/** React Flow's transform: translate x, translate y, zoom. */
export type Transform = readonly [number, number, number]

export interface Point {
  x: number
  y: number
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** What the cursor points at, kept in flow terms so it stays on it through pans, zooms and moves. */
export type Aim = Pick<CanvasCursorOp, 'node' | 'anchor' | 'at'>

/**
 * How far inside a card's edge an edge anchor lands, in screen px (at most a quarter of the card),
 * so the arrow's tip sits on the card and not on the board beside it.
 */
export const EDGE_INSET = 12

/** Flow point `p` on screen at transform `t`. */
export function toScreen(p: Point, t: Transform): Point {
  return { x: p.x * t[2] + t[0], y: p.y * t[2] + t[1] }
}

/**
 * The screen point the cursor aims at: a card's anchor as drawn now, else the flow point `at`.
 * Null when it names a card the board doesn't have and gives no point.
 */
export function aimOnScreen(aim: Aim, boxes: ReadonlyMap<string, Box>, t: Transform): Point | null {
  const box = aim.node === undefined ? undefined : boxes.get(aim.node)
  if (!box) return aim.at ? toScreen(aim.at, t) : null
  const { x, y } = toScreen(box, t)
  const w = box.w * t[2]
  const h = box.h * t[2]
  const ix = Math.min(EDGE_INSET, w / 4)
  const iy = Math.min(EDGE_INSET, h / 4)
  switch (aim.anchor ?? 'center') {
    case 'left':
      return { x: x + ix, y: y + h / 2 }
    case 'right':
      return { x: x + w - ix, y: y + h / 2 }
    case 'top':
      return { x: x + w / 2, y: y + iy }
    case 'bottom':
      return { x: x + w / 2, y: y + h - iy }
    case 'center':
      return { x: x + w / 2, y: y + h / 2 }
  }
}

/**
 * The viewport a `view` call asks for on a board `size` px wide and high: `center` (flow) in the
 * middle at `zoom`, each defaulting to what is shown now, then moved by `pan` screen px.
 */
export function viewTarget(
  vp: Viewport,
  size: { w: number; h: number },
  want: { zoom?: number; center?: Point; pan?: { dx: number; dy: number } },
): Viewport {
  const zoom = want.zoom ?? vp.zoom
  const center = want.center ?? {
    x: (size.w / 2 - vp.x) / vp.zoom,
    y: (size.h / 2 - vp.y) / vp.zoom,
  }
  return {
    x: size.w / 2 - center.x * zoom + (want.pan?.dx ?? 0),
    y: size.h / 2 - center.y * zoom + (want.pan?.dy ?? 0),
    zoom,
  }
}

/**
 * Board chrome the agent's work keeps clear of, in screen px: page menu and tools on top, zoom
 * controls on the left, and room for the cursor's avatar badge right and below.
 */
export const REVEAL_INSET = { top: 72, right: 56, bottom: 56, left: 72 } as const
/**
 * Below this zoom a card's text is too small to read (body text ~11 px at 1); revealing the
 * agent's work brings the board up to it, as far as the work still fits.
 */
export const READ_ZOOM = 1
/** How long the board takes to bring the agent's work into view. */
export const REVEAL_MS = 420
/** The share of the work's own zoom the cards around it may cost before they are left out. */
const CONTEXT_ZOOM = 0.9

/**
 * The viewport that shows flow box `need` clear of the board's chrome on a board `size` px wide
 * and high, or null when it already shows there. `want` (around `need`, the cards around the work)
 * shows too when it fits at nearly the zoom `need` gets alone; else only `need` does, so the
 * work stays readable in a narrow pane. The zoom stays unless the board is zoomed out past
 * reading (then up to READ_ZOOM) or the box can't fit (then down until it does); the box comes in
 * by the least move, so the board doesn't jump for work just past an edge.
 */
export function revealView(
  vp: Viewport,
  size: { w: number; h: number },
  need: Box,
  want: Box | null = null,
  inset: { top: number; right: number; bottom: number; left: number } = REVEAL_INSET,
): Viewport | null {
  const room = { w: size.w - inset.left - inset.right, h: size.h - inset.top - inset.bottom }
  if (room.w <= 0 || room.h <= 0) return null
  const zoomFor = (b: Box): number =>
    Math.min(Math.max(vp.zoom, READ_ZOOM), room.w / b.w, room.h / b.h)
  const box = want && zoomFor(want) >= zoomFor(need) * CONTEXT_ZOOM ? want : need
  const zoom = zoomFor(box)
  // Least move along each axis: no move when the box is already inside, else just enough (or
  // centered once the zoom changes, which moves everything anyway).
  const axis = (t: number, lo: number, len: number, inner: number): number => {
    const a = lo * zoom + t
    const b = a + len * zoom
    if (zoom !== vp.zoom) return inner / 2 - (lo + len / 2) * zoom
    if (a >= 0 && b <= inner) return t
    return a < 0 ? t - a : t - (b - inner)
  }
  const x = inset.left + axis(vp.x - inset.left, box.x, box.w, room.w)
  const y = inset.top + axis(vp.y - inset.top, box.y, box.h, room.h)
  if (zoom === vp.zoom && Math.abs(x - vp.x) < 0.5 && Math.abs(y - vp.y) < 0.5) return null
  return { x, y, zoom }
}

/** The smallest box around `boxes`; null for none. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const r = Math.max(...boxes.map((b) => b.x + b.w))
  const bt = Math.max(...boxes.map((b) => b.y + b.h))
  return { x, y, w: r - x, h: bt - y }
}

/** Ease in and out (cubic), for a card the agent carries: `t` in 0..1. */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}
