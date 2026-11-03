/**
 * Where an in-app destination opens:
 * - `split`: a pane right of the current view (a tab of the right pane when one is open).
 * - `tab`: a new top-level tab (Cmd+Shift-click, middle-click).
 * - `here`: replaces what the focused tab or pane shows.
 */
export type OpenTarget = 'split' | 'tab' | 'here'

export interface ClickMods {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  button?: number
}

/** Cmd+Shift-click and middle-click ask for a new top-level tab. */
const wantsTab = (e: ClickMods): boolean =>
  e.button === 1 || ((e.metaKey === true || e.ctrlKey === true) && e.shiftKey === true)

/**
 * A click inside a chat (links, cards, rows): a split by default and with Cmd, a new tab with
 * Cmd+Shift or a middle click, the same tab with Option.
 */
export function openTargetOf(e: ClickMods): OpenTarget {
  if (wantsTab(e)) return 'tab'
  if (e.altKey === true) return 'here'
  return 'split'
}

/**
 * A click on a navigation item (sidebar, lists, breadcrumbs): the current tab by default, a split
 * with Cmd, a new tab with Cmd+Shift or a middle click.
 */
export function navTargetOf(e: ClickMods): OpenTarget {
  if (wantsTab(e)) return 'tab'
  if (e.metaKey === true || e.ctrlKey === true) return 'split'
  return 'here'
}
