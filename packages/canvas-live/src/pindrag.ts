// Moving a comment pin and its popover (Figma style), as pure geometry shared by the room page and
// Relay Desktop's Canvas page: where a dragged pin lands (on the card under the drop point, else on
// the board), and keeping a dragged popover on screen. No DOM, so tests call these directly.

import type { Box, ThreadAnchor } from "./threads";

/** Pointer travel (px) before a press on a pin is a drag and not a click that opens its thread. */
export const DRAG_THRESHOLD = 4;

/**
 * The anchor for a pin dropped with its tip at board point `at`: on the card under it (the smallest
 * one holding the point, so a card inside a frame wins over the frame) with the offset from that
 * card's top left, else the board point itself. Coordinates are whole numbers, as thread files keep them.
 */
export function anchorAtPoint(at: { x: number; y: number }, boxes: ReadonlyMap<string, Box>): ThreadAnchor {
  let best: { id: string; box: Box } | null = null;
  for (const [id, box] of boxes) {
    if (at.x < box.x || at.x > box.x + box.w || at.y < box.y || at.y > box.y + box.h) continue;
    if (best === null || box.w * box.h <= best.box.w * best.box.h) best = { id, box };
  }
  if (best === null) return { x: Math.round(at.x), y: Math.round(at.y) };
  return { node: best.id, x: Math.round(at.x - best.box.x), y: Math.round(at.y - best.box.y) };
}

export interface Offset {
  dx: number;
  dy: number;
}

/**
 * `offset` (how far a popover was dragged from where it opens) clamped so the popover, whose
 * undragged rectangle is `base`, stays inside `bounds` with `margin` to spare; it stays as far in as
 * it fits when it is bigger than the bounds.
 */
export function clampOffset(
  base: { x: number; y: number; w: number; h: number },
  offset: Offset,
  bounds: { w: number; h: number },
  margin = 8,
): Offset {
  const x = Math.min(Math.max(base.x + offset.dx, margin), Math.max(margin, bounds.w - base.w - margin));
  const y = Math.min(Math.max(base.y + offset.dy, margin), Math.max(margin, bounds.h - base.h - margin));
  return { dx: x - base.x, dy: y - base.y };
}

/** Popover offsets by thread for this page load (a session): dragged once, it stays there when reopened. */
export class OffsetMemory {
  private readonly offsets = new Map<string, Offset>();

  get(key: string): Offset {
    return this.offsets.get(key) ?? { dx: 0, dy: 0 };
  }

  set(key: string, offset: Offset): void {
    if (offset.dx === 0 && offset.dy === 0) this.offsets.delete(key);
    else this.offsets.set(key, offset);
  }
}
