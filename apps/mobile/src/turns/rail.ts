/**
 * Pure pieces of the turn rail (`turns/TurnRail.tsx`): how many ticks fit, which turn is on screen,
 * and where the preview card goes. The turn model itself (what a turn is, its flag, how ticks are
 * compressed) is chat-core's `turns`, shared with Relay desktop.
 */
import { turnOfItem, type Turn } from "@evaos/chat-core/turns";

/** Width of the rail's touch zone, left of the thread. */
export const RAIL_WIDTH = 28;
/** Height of one tick's slot. */
export const TICK_PITCH = 9;
/** Height the filter toggle takes above the ticks. */
export const FILTER_ROOM = 32;
/** Share of the area the rail may take. */
export const MAX_SHARE = 0.72;
/** Turns needed before a rail shows at all. */
export const MIN_TURNS = 3;

/** Ticks that fit a rail area `height` points tall. */
export function slotsFor(height: number): number {
  return Math.max(1, Math.floor((height * MAX_SHARE - FILTER_ROOM) / TICK_PITCH));
}

/** A tick's bar length by state: the turn on screen is the longest. */
export function tickLength(state: "active" | "visible" | "idle"): number {
  return state === "active" ? 17 : state === "visible" ? 12 : 8;
}

/**
 * The rows on screen as chronological positions (0 = the oldest row): the top one is the oldest
 * visible, the bottom one the newest. `flat` are the inverted list's viewable indices (0 = newest);
 * null while none is known.
 */
export function viewableRange(
  flat: readonly number[],
  rowCount: number,
): { top: number; bottom: number } | null {
  if (flat.length === 0 || rowCount === 0) return null;
  return { top: rowCount - 1 - Math.max(...flat), bottom: rowCount - 1 - Math.min(...flat) };
}

export interface RailView {
  /** Index in the shown turns of the one the reader is in. */
  active: number;
  /** Shown turns with a row on screen (inclusive). */
  range: [number, number];
}

/**
 * Which of the shown turns is on screen. A reader following the newest message is in the last turn;
 * otherwise in the one containing the topmost visible row. Nothing known: the last turn.
 */
export function railView(
  shown: readonly Turn[],
  rows: { top: number; bottom: number } | null,
  following: boolean,
): RailView {
  const last = Math.max(0, shown.length - 1);
  if (rows === null || following) {
    const from = rows === null ? last : turnOfItem(shown, rows.top);
    return { active: last, range: [Math.min(from, last), last] };
  }
  const active = turnOfItem(shown, rows.top);
  return { active, range: [active, Math.max(active, turnOfItem(shown, rows.bottom))] };
}

/** Where the preview card's top goes: centred on the finger, kept inside [top, bottom] with `margin` to spare. */
export function cardTop(
  y: number,
  cardHeight: number,
  top: number,
  bottom: number,
  margin: number,
): number {
  const low = top + margin;
  const high = bottom - margin - cardHeight;
  return Math.max(low, Math.min(y - cardHeight / 2, Math.max(low, high)));
}
