import { placeKey, type Place } from './place'

/**
 * The app-wide navigation history (Back and Forward for the whole window, like a browser's). Pure
 * data and reducers; nav-history.machine.ts decides when a spot is recorded and when a step is
 * being restored. The desktop runtime (renderer/navigation/nav-history.ts) reads the spot from the
 * tabs and tiling stores and applies one back to them.
 */

export const NAV_HISTORY_CAP = 100

/** Where a chat's log was scrolled (the renderer's ChatScroll). */
export interface SpotScroll {
  offset: number
  pinned: boolean
}

/**
 * Where Isaac was: the workspace on screen, the app tab in front and what it shows, and the tool
 * tab (page tab, canvas, meeting, files) that held the focus when one did.
 */
export interface Spot {
  ws: string
  /** The app tab in front. */
  tab: number
  place: Place
  /** The focused pane's tool tab id; null when an app tab (a chat or a page) was in front. */
  front: string | null
  /** The chat's scroll when it was last seen. Never part of what makes two spots the same. */
  scroll: SpotScroll | null
}

export interface NavHistory {
  entries: Spot[]
  /** The entry Isaac is at; -1 while empty. */
  index: number
}

export const emptyHistory = (): NavHistory => ({ entries: [], index: -1 })

/** What makes two spots one entry: where, not how far the log was scrolled. */
export function spotKey(s: Spot): string {
  return `${s.ws}|${s.tab}|${placeKey(s.place)}|${s.front ?? ''}`
}

export const sameSpot = (a: Spot, b: Spot): boolean => spotKey(a) === spotKey(b)

export const currentSpot = (h: NavHistory): Spot | null => h.entries[h.index] ?? null

export const canStep = (h: NavHistory, delta: -1 | 1): boolean => {
  const to = h.index + delta
  return to >= 0 && to < h.entries.length
}

/**
 * Isaac arrived at `spot`. The same place as the current entry only refreshes it (its scroll); a
 * new one drops everything forward of the current entry and is pushed, the oldest falling off
 * past the cap.
 */
export function visit(h: NavHistory, spot: Spot): NavHistory {
  const cur = currentSpot(h)
  if (cur && sameSpot(cur, spot)) return refresh(h, spot)
  const kept = h.entries.slice(0, h.index + 1)
  kept.push(spot)
  const over = Math.max(0, kept.length - NAV_HISTORY_CAP)
  const entries = over > 0 ? kept.slice(over) : kept
  return { entries, index: entries.length - 1 }
}

/** Replaces the current entry's details (scroll, a title the place got) with `spot`'s. */
export function refresh(h: NavHistory, spot: Spot): NavHistory {
  if (h.index < 0) return h
  const entries = h.entries.slice()
  entries[h.index] = spot
  return { entries, index: h.index }
}

/** Moves to entry `index`; the history itself stays whole so Forward still works. */
export function moveTo(h: NavHistory, index: number): NavHistory {
  if (!Number.isInteger(index) || index < 0 || index >= h.entries.length || index === h.index) {
    return h
  }
  return { entries: h.entries, index }
}
