// What Relay Desktop's Canvas page hands the room page when a live room takes over the board it is
// showing: the same page, view, selection and open thread, so the switch from the offline board to
// the live room is not a reload Isaac has to find his place again after. The desktop posts
// `{ type: "canvas.restore", carry }` into the room's frame (once it said `canvas.ready`); the room
// applies it and answers `canvas.positioned` when the frame shows exactly that, and only then does
// the desktop swap the frame in.

export const RESTORE_MESSAGE = "canvas.restore";
export const POSITIONED_EVENT = "canvas.positioned";

export interface CarryViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Carry {
  /** The page the viewer was on. */
  page: string;
  /** Where that page was panned and zoomed; null: the room opens it as it would anyway. */
  viewport: CarryViewport | null;
  /** The selected cards of that page. */
  selection: string[];
  /** The comment thread open on that page, with its popover. */
  thread: string | null;
}

const MAX_SELECTION = 2_000;
const isFinite_ = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isId = (v: unknown, max: number): v is string => typeof v === "string" && v !== "" && v.length <= max;

/** The message that carries `carry` into the room's frame. */
export function restoreMessage(carry: Carry): { type: typeof RESTORE_MESSAGE; carry: Carry } {
  return { type: RESTORE_MESSAGE, carry };
}

/** The carry in a `canvas.restore` message; null for anything else or anything malformed. */
export function parseRestore(data: unknown): Carry | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as { type?: unknown; carry?: unknown };
  if (message.type !== RESTORE_MESSAGE || typeof message.carry !== "object" || message.carry === null) return null;
  const raw = message.carry as { page?: unknown; viewport?: unknown; selection?: unknown; thread?: unknown };
  if (!isId(raw.page, 200)) return null;
  let viewport: CarryViewport | null = null;
  if (raw.viewport !== null && raw.viewport !== undefined) {
    const v = raw.viewport as { x?: unknown; y?: unknown; zoom?: unknown };
    if (!isFinite_(v.x) || !isFinite_(v.y) || !isFinite_(v.zoom) || v.zoom <= 0) return null;
    viewport = { x: v.x, y: v.y, zoom: v.zoom };
  }
  const selection = Array.isArray(raw.selection) ? raw.selection.filter((id): id is string => isId(id, 500)).slice(0, MAX_SELECTION) : [];
  const thread = isId(raw.thread, 60) ? raw.thread : null;
  return { page: raw.page, viewport, selection, thread };
}

/**
 * What the room does with a carry once it has synced: which page to move to (null: already there)
 * and whether the carried view applies to the page the room ends up on. Pages the room no longer
 * has are skipped, leaving the room on the page it opened on.
 */
export function planRestore(carry: Carry, current: string, pages: readonly string[]): { page: string | null; applies: boolean } {
  if (carry.page === current) return { page: null, applies: true };
  return pages.includes(carry.page) ? { page: carry.page, applies: true } : { page: null, applies: false };
}
