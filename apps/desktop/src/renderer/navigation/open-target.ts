/**
 * Where a destination opens. Clicks map to the first four (see targetOf); `tab` is for explicit
 * "Open in new tab" menus and the agent's link.open.
 * - `here`: in this workspace, in front and focused (a chat of another workspace switches to it).
 * - `background`: in this workspace as a tab that does not come to the front or take focus.
 * - `split`: a new split beside the current pane.
 * - `external`: outside Relay (web links only: Arc).
 * - `tab`: a new top-level app tab.
 */
export type OpenTarget = 'here' | 'background' | 'split' | 'external' | 'tab'

export interface ClickMods {
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  button?: number
}

/**
 * The one click rule for every in-app link, row and navigation item: plain = here, Cmd (or a
 * middle click) = background, Cmd+Shift = split, Option = external.
 */
export function targetOf(e: ClickMods): OpenTarget {
  const cmd = e.metaKey === true || e.ctrlKey === true
  if (cmd && e.shiftKey === true) return 'split'
  if (cmd || e.button === 1) return 'background'
  if (e.altKey === true) return 'external'
  return 'here'
}

/** A click inside a chat (links, cards, rows). */
export const openTargetOf = targetOf

/** A click on a navigation item (sidebar, lists, breadcrumbs). Same rule as everywhere. */
export const navTargetOf = targetOf
