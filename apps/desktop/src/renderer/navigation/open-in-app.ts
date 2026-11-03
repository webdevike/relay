import { isChatPane, pageTabAllowed, type Place } from '@evaos/shell-core'
import { navigateTo } from '../tabs/tabs-store'
import { openTab, tilingStore } from '../tiling/tiling-store'
import { navTargetOf, type ClickMods, type OpenTarget } from './open-target'
import { openPlace } from './navigate'

/**
 * Shows an in-app place for a click inside a chat (see OpenTarget). `split` adds it as a tab of
 * the tool pane when one is open, else splits one off right of the chat; a chat can't live in a
 * tool pane, so it gets a new tab instead. `here` navigates the chat pane's tab, or adds a tab to
 * the focused tool pane.
 */
export function openInApp(place: Place, target: OpenTarget = 'split'): void {
  if (target === 'split') {
    if (pageTabAllowed(place)) openTab({ kind: 'page', place })
    else navigateTo(place, { newTab: true })
    return
  }
  if (target === 'tab') {
    navigateTo(place, { newTab: true })
    return
  }
  const focus = tilingStore.getState().tiling.focus
  if (isChatPane(focus) || !pageTabAllowed(place)) navigateTo(place)
  else openTab({ kind: 'page', place }, focus)
}

/**
 * Shows `place` for a navigation click: the current tab, a split or a new tab. Same tab and new
 * tab go through openPlace, like the sidebar always did.
 */
export function openPlaceAt(place: Place, target: OpenTarget): void {
  if (target === 'split') openInApp(place, 'split')
  else openPlace(place, { newTab: target === 'tab' })
}

/** A click on a navigation item: the current tab, Cmd a split, Cmd+Shift or middle a new tab. */
export function openFromNav(place: Place, e: ClickMods): void {
  openPlaceAt(place, navTargetOf(e))
}
