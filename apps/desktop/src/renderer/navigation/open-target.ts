/**
 * Where an in-app destination clicked from inside a chat opens:
 * - `split`: a pane right of the chat (a tab of the right pane when one is open). The default.
 * - `tab`: a new top-level tab (Cmd+click).
 * - `here`: replaces what the focused tab or pane shows (Option+click).
 */
export type OpenTarget = 'split' | 'tab' | 'here'

export function openTargetOf(e: { metaKey?: boolean; altKey?: boolean }): OpenTarget {
  if (e.metaKey === true) return 'tab'
  if (e.altKey === true) return 'here'
  return 'split'
}
