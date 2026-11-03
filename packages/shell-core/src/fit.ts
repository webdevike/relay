/** Shell geometry, after apps/evaos layout.rs `fit`. */
export const GAP = 8
export const TRAFFIC_LIGHTS = 80
export const MAIN_MIN = 480
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 420
export const SIDEBAR_DEFAULT = 272
/** The side panel's width before tiling, still read once to size the first tool pane. */
export const PANEL_DEFAULT = 420

/**
 * The sidebar's fitted width: 0 (folded) when the window cannot hold it next to the tiling's
 * smallest width (`contentMin`, gaps inside it included), else the wanted width clamped to the
 * room left. Undefined (hidden) yields 0.
 */
export function fitSidebar(
  window: number,
  sidebar: number | undefined,
  contentMin: number,
): number {
  if (sidebar === undefined) return 0
  const room = window - contentMin - GAP
  if (room < SIDEBAR_MIN) return 0
  return Math.min(Math.max(sidebar, SIDEBAR_MIN), SIDEBAR_MAX, room)
}
