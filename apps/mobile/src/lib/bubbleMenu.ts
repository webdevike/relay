/**
 * Pure pieces of the long-press overlay on a chat bubble (`ui/BubbleContextOverlay`): where the
 * lifted bubble, the reaction bar above it and the menu below it go, and what Reply puts in the
 * composer.
 */
import { untagged } from "@relay/protocol";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface OverlayPlacementInput {
  /** The bubble as it sits on screen, in the overlay's coordinates. */
  bubble: Rect;
  /** The overlay's size (the whole screen). */
  screen: Size;
  /** Safe-area insets the bar and menu stay clear of. */
  insets: { top: number; bottom: number };
  /** Which edge the bubble hugs: Isaac's on the right, the agent's on the left. Bar and menu align to it. */
  side: "left" | "right";
  bar: Size;
  menu: Size;
  /** Scale of the lifted bubble (1 for none, as with Reduce Motion). */
  lift: number;
  /** Space between the bubble and the bar or menu. */
  gap: number;
  /** Space kept from the screen edges and safe areas. */
  margin: number;
}

export interface OverlayPlacement {
  /** Where the lifted bubble is drawn, unscaled; it scales about its center by `scale`. */
  bubble: Rect;
  scale: number;
  /** How far down the bubble's own content the shown part starts: nonzero only for a bubble taller than the room. */
  contentOffset: number;
  bar: { x: number; y: number };
  menu: { x: number; y: number };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Lays out the overlay the way iMessage does: the bubble stays where it was when the bar fits
 * above it and the menu below it; near the top or bottom of the screen the bubble slides down or
 * up just enough to make room. A bubble taller than the room left between bar and menu is shown
 * unscaled and clipped to that room, keeping the part that was on screen.
 */
export function overlayPlacement(input: OverlayPlacementInput): OverlayPlacement {
  const { bubble, screen, insets, side, bar, menu, gap, margin } = input;
  const top = insets.top + margin;
  const bottom = screen.height - insets.bottom - margin;
  const room = bottom - top - bar.height - menu.height - gap * 2;
  const tall = bubble.height * input.lift > room;
  const scale = tall ? 1 : input.lift;
  const height = tall ? Math.max(room, 0) : bubble.height;
  // The grown bubble's top and bottom stick out by half its growth each way.
  const growth = (height * (scale - 1)) / 2;
  const minTop = top + bar.height + gap + growth;
  const maxTop = bottom - menu.height - gap - height - growth;
  const y = tall ? minTop : clamp(bubble.y, minTop, maxTop);
  const contentOffset = tall ? clamp(y - bubble.y, 0, bubble.height - height) : 0;
  const along = (width: number): number =>
    clamp(side === "right" ? bubble.x + bubble.width - width : bubble.x, margin, screen.width - margin - width);
  return {
    bubble: { x: bubble.x, y, width: bubble.width, height },
    scale,
    contentOffset,
    bar: { x: along(bar.width), y: y - growth - gap - bar.height },
    menu: { x: along(menu.width), y: y + height + growth + gap },
  };
}

/** `text` as a Markdown quote: every line behind `> ` (a blank line as a bare `>`), surface tags dropped. */
export function markdownQuote(text: string): string {
  return untagged(text)
    .trim()
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * Reply: the quote of `text` goes in `draft` above the line the cursor is on, followed by a blank
 * line so what Isaac types next is not part of the quote. Returns the new draft and where the
 * cursor goes: the same spot in the text it was in, now below the quote.
 */
export function quoteIntoDraft(draft: string, cursor: number, text: string): { draft: string; cursor: number } {
  const at = clamp(cursor, 0, draft.length);
  const lineStart = at === 0 ? 0 : draft.lastIndexOf("\n", at - 1) + 1;
  const block = `${markdownQuote(text)}\n\n`;
  return { draft: draft.slice(0, lineStart) + block + draft.slice(lineStart), cursor: at + block.length };
}
