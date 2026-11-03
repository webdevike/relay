import type { Place } from '@evaos/shell-core'
import { navigateTo } from '../tabs/tabs-store'
import { openPlaceBeside, openPlaceHere } from '../tiling/tiling-store'
import { navTargetOf, type ClickMods, type OpenTarget } from './open-target'
import { openPlace } from './navigate'

/**
 * Shows an in-app place for a click inside a chat (see OpenTarget). `split` opens it as a tab of
 * the pane right of the app tab in front, else a pane split off right of it; any pane takes chats
 * and pages alike. `tab` opens a new top-level tab; `here` navigates the focused pane's app tab
 * (or adds one where a tool tab is in front).
 */
export function openInApp(place: Place, target: OpenTarget = 'split'): void {
  if (target === 'split') openPlaceBeside(place)
  else if (target === 'tab') navigateTo(place, { newTab: true })
  else openPlaceHere(place)
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
