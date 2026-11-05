import { pageTab, type Place } from '@evaos/shell-core'
import { navigateTo } from '../tabs/tabs-store'
import {
  activateTab,
  focusPaneById,
  openPlaceBeside,
  paneSnapshot,
  splitAt,
  tilingStore,
} from '../tiling/tiling-store'
import { navTargetOf, type ClickMods, type OpenTarget } from './open-target'
import { openPlace } from './navigate'

/** A chat or an assistant's thread: an app tab, never a page tab. */
const isChatPlace = (p: Place): boolean => p.page === 'chat' || p.page.startsWith('agent:')

/**
 * Runs `open` and puts back what was in front: every pane's front tab and the focused pane. A
 * background open adds its tab without bringing it forward or taking focus.
 */
export function inBackground(open: () => void): void {
  const before = paneSnapshot()
  open()
  const after = paneSnapshot()
  for (const pane of after.panes) {
    const was = before.panes.find((p) => p.id === pane.id)?.active ?? null
    if (was !== null && pane.active !== was && pane.views.includes(was)) activateTab(was)
  }
  const focus = before.focus
  if (focus !== null && tilingStore.getState().focus !== focus) {
    if (after.panes.some((p) => p.id === focus)) focusPaneById(focus)
  }
}

/** Opens `place` in a new split right of the focused pane (a chat goes beside the chat). */
function openInSplit(place: Place): void {
  const focus = tilingStore.getState().focus
  if (isChatPlace(place) || focus === null) openPlaceBeside(place)
  else splitAt(focus, 'right', pageTab(place))
}

/**
 * Shows an in-app place for a click inside a chat (see OpenTarget). `here` opens it in this
 * workspace and focuses it (a page as a tab beside the chat; a chat of another workspace switches
 * to that workspace); `background` adds it without bringing it forward; `split` opens a new split
 * beside the focused pane; `tab` a new top-level tab. `external` has no meaning for a place and
 * opens it here.
 */
export function openInApp(place: Place, target: OpenTarget = 'here'): void {
  if (target === 'background') inBackground(() => openPlaceBeside(place))
  else if (target === 'split') openInSplit(place)
  else if (target === 'tab') navigateTo(place, { newTab: true })
  else openPlaceBeside(place)
}

/**
 * Shows `place` for a navigation click: `here` navigates the current tab (switching workspace as
 * the place says), a new tab through openPlace; background and split as openInApp.
 */
export function openPlaceAt(place: Place, target: OpenTarget): void {
  if (target === 'background' || target === 'split') openInApp(place, target)
  else openPlace(place, { newTab: target === 'tab' })
}

/** A click on a navigation item: plain here, Cmd background, Cmd+Shift split. */
export function openFromNav(place: Place, e: ClickMods): void {
  openPlaceAt(place, navTargetOf(e))
}
