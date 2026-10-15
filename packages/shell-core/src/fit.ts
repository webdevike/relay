/** Shell geometry, a verbatim port of apps/evaos layout.rs `fit`. */
export const GAP = 8
export const TRAFFIC_LIGHTS = 80
export const MAIN_MIN = 480
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 420
export const SIDEBAR_DEFAULT = 272
export const PANEL_MIN = 320
export const PANEL_DEFAULT = 420

export interface Widths {
  sidebar: number
  panel: number
}

/** Fits wanted widths. Undefined means hidden/closed, which yields 0. The panel shrinks first. */
export function fit(window: number, sidebar?: number, panel?: number): Widths {
  const panelRoom = panel !== undefined ? PANEL_MIN + GAP : 0
  const sidebarW =
    sidebar === undefined
      ? 0
      : (() => {
          const room = window - MAIN_MIN - GAP - panelRoom
          if (room < SIDEBAR_MIN) return 0
          return Math.min(Math.max(Math.max(sidebar, SIDEBAR_MIN), 0), SIDEBAR_MAX, room)
        })()
  const left = sidebarW > 0 ? 0 : GAP
  const panelW =
    panel === undefined
      ? 0
      : (() => {
          const available = Math.max(window - left - sidebarW - 2 * GAP, 0)
          return Math.min(
            Math.max(panel, PANEL_MIN),
            Math.max(available - MAIN_MIN, PANEL_MIN),
            available,
          )
        })()
  return { sidebar: sidebarW, panel: panelW }
}

export function mainWidth(window: number, w: Widths): number {
  const left = w.sidebar > 0 ? 0 : GAP
  const panel = w.panel > 0 ? w.panel + GAP : 0
  return window - left - w.sidebar - GAP - panel
}
