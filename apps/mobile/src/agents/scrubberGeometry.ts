/**
 * Geometry for the session scrubber. Slots keep a minimum width and, past that, the content scrolls
 * inside the track instead of squeezing. Content is the slots plus an inset at each end, sized so
 * the thumb centred on the first or last dot still clears the track's rounded ends. All coordinates
 * are in points; `offset` is how far the content is scrolled left. Every function is a worklet so
 * the gesture and the frame loop run it on the UI thread.
 */

/** Gap between the thumb and the track's edge. */
export const TRACK_PADDING = 4;
/** Narrowest a slot gets before the track starts scrolling instead of squeezing. */
export const MIN_SLOT = 40;
/** Narrowest the thumb gets: wider than it is tall, so it always reads as a pill, even when a
 * slot is narrower than that. A wider thumb overhangs its slot evenly without reaching the
 * neighbouring dots. */
export const MIN_THUMB = 48;
/** Band at each end of the track where a held finger scrolls the content. */
export const EDGE_ZONE = 40;
/** Scroll speed with the finger at (or past) the very end of the track. */
export const EDGE_SPEED = 360;
/** Finger travel before edge scrolling arms, so a tap on an end slot doesn't drift the track. */
export const ARM_DISTANCE = 10;

/** Thumb width for a slot: the slot minus padding, never below `MIN_THUMB`. */
export function thumbWidth(slot: number): number {
  "worklet";
  return slot <= 0 ? 0 : Math.max(MIN_THUMB, slot - TRACK_PADDING * 2);
}

/** Space before the first slot (and after the last) so a thumb centred on an end dot fits. */
export function endInset(slot: number): number {
  "worklet";
  return slot <= 0 ? 0 : Math.max(0, TRACK_PADDING + thumbWidth(slot) / 2 - slot / 2);
}

/**
 * Width of one slot. Slots share the track evenly while each still fits a padded thumb; below
 * that, the end insets come out of the track first so the content stays exactly track-wide until
 * slots hit `MIN_SLOT`, and only then does it overflow and scroll.
 */
export function slotWidthFor(trackWidth: number, count: number): number {
  "worklet";
  if (count <= 0 || trackWidth <= 0) return 0;
  const even = trackWidth / count;
  if (count === 1 || even >= MIN_THUMB + TRACK_PADDING * 2) return even;
  return Math.max(MIN_SLOT, (trackWidth - MIN_THUMB - TRACK_PADDING * 2) / (count - 1));
}

/** Total content width: every slot plus both end insets. */
export function contentWidth(slot: number, count: number): number {
  "worklet";
  return count <= 0 ? 0 : slot * count + endInset(slot) * 2;
}

/** Centre of slot `index` (fractional while dragging) in content coordinates. */
export function slotCenter(index: number, slot: number): number {
  "worklet";
  return endInset(slot) + index * slot + slot / 2;
}

/** The thumb's left edge and width in content coordinates, centred on slot `index`. */
export function thumbSpan(index: number, slot: number): { x: number; width: number } {
  "worklet";
  const width = thumbWidth(slot);
  return { x: slotCenter(index, slot) - width / 2, width };
}

/** Slot under content position `x`, clamped to the slots. */
export function slotAt(x: number, slot: number, count: number): number {
  "worklet";
  if (slot <= 0 || count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor((x - endInset(slot)) / slot)));
}

/** Furthest the content can scroll; 0 when it fits. */
export function maxOffset(trackWidth: number, slot: number, count: number): number {
  "worklet";
  return Math.max(0, contentWidth(slot, count) - trackWidth);
}

/** The offset nearest `offset` that shows the whole thumb on slot `index`, with its padding. */
export function revealOffset(offset: number, index: number, slot: number, count: number, trackWidth: number): number {
  "worklet";
  const { x, width } = thumbSpan(index, slot);
  const start = x - TRACK_PADDING;
  const end = x + width + TRACK_PADDING;
  const target = Math.min(start, Math.max(offset, end - trackWidth));
  return Math.min(maxOffset(trackWidth, slot, count), Math.max(0, target));
}

/**
 * The offset after one frame of edge scrolling with the finger at `fingerX` (track coordinates).
 * Speed ramps from 0 at the inner edge of the band to `EDGE_SPEED` at the track's end and beyond.
 */
export function edgeScroll(offset: number, fingerX: number, trackWidth: number, max: number, dtSeconds: number): number {
  "worklet";
  if (max <= 0) return offset;
  let depth = 0;
  if (fingerX < EDGE_ZONE) depth = -(EDGE_ZONE - fingerX) / EDGE_ZONE;
  else if (fingerX > trackWidth - EDGE_ZONE) depth = (fingerX - (trackWidth - EDGE_ZONE)) / EDGE_ZONE;
  if (depth === 0) return offset;
  depth = Math.min(1, Math.max(-1, depth));
  return Math.min(max, Math.max(0, offset + depth * EDGE_SPEED * dtSeconds));
}
