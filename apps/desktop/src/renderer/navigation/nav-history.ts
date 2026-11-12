import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { createActor, type Actor } from 'xstate'
import {
  activeTab,
  appPanelId,
  appTabOf,
  emptyHistory,
  navHistoryMachine,
  spotKey,
  type NavEvent,
  type NavHistory,
  type Spot,
} from '@evaos/shell-core'
import { chatScrollOf, requestChatScroll } from '../chat/chat-scroll'
import { registerAction, runAction } from '../hotkeys/router'
import { activateTab, tilingStore } from '../tiling/tiling-store'
import { restoreTab, tabsStore } from '../tabs/tabs-store'

/**
 * The window's Back and Forward (docs/state-machines/nav-history.md). This reads where Isaac is
 * (the workspace, the app tab in front and what it shows, the focused tool tab) from the tabs and
 * tiling stores, feeds it to the history machine, and puts the screen back at an entry when the
 * machine steps. Every page's back control calls `historyBack` or `backOr`; nothing else keeps a
 * history of where Isaac was.
 */

/** The history as the header's buttons and list read it. */
export const navHistoryStore = createStore<NavHistory>(emptyHistory)

export function useNavHistory<T>(selector: (h: NavHistory) => T): T {
  return useStore(navHistoryStore, selector)
}

export const canGoBack = (h: NavHistory): boolean => h.index > 0
export const canGoForward = (h: NavHistory): boolean =>
  h.index >= 0 && h.index < h.entries.length - 1

let actor: Actor<typeof navHistoryMachine> | null = null
let started: (() => void) | null = null
let lastKey = ''

/** Where Isaac is now; null until the tabs and the panes are both loaded. */
export function readSpot(): Spot | null {
  const { tabs, loaded } = tabsStore.getState()
  const t = tilingStore.getState()
  if (!loaded || !t.loaded) return null
  const tab = activeTab(tabs)
  const active = t.panes.find((p) => p.id === t.focus)?.active ?? null
  const place = tab.here
  const file = place.page === 'chat' && place.chat !== 'draft' ? place.chat : null
  return {
    ws: t.scope,
    tab: tab.id,
    place,
    front: active !== null && appTabOf(active) === null ? active : null,
    scroll: file ? chatScrollOf(file) : null,
  }
}

/** Puts the screen back at `spot`: its tab and place, the chat's scroll, the focused tool tab. */
function applySpot(spot: Spot): void {
  const { place } = spot
  if (place.page === 'chat' && place.chat && place.chat !== 'draft' && spot.scroll) {
    requestChatScroll(place.chat, spot.scroll)
  }
  restoreTab(spot.tab, place)
  const id = spot.front ?? appPanelId(activeTab(tabsStore.getState().tabs).id)
  try {
    activateTab(id)
  } catch {
    // The tool tab was closed since (or the panes are not there): the place is showing.
  }
}

function observe(): void {
  const spot = readSpot()
  if (!spot || !actor) return
  const key = spotKey(spot)
  if (key === lastKey) return
  lastKey = key
  actor.send({ type: 'spot.changed', spot })
}

/** A step: first the spot as it is (the chat's scroll stays with the entry), then the step. */
function step(event: NavEvent): void {
  if (!actor) return
  const spot = readSpot()
  if (spot) actor.send({ type: 'spot.changed', spot })
  actor.send(event)
}

export const historyBack = (): void => step({ type: 'history.back' })
export const historyForward = (): void => step({ type: 'history.forward' })
/** The history list: straight to entry `index`. */
export const historyJump = (index: number): void => step({ type: 'history.jump', index })

/**
 * Back for a page's own back control: the window's history, else `fallback` (what the control
 * did before there was one), so a window with nothing behind it still goes somewhere.
 */
export function backOr(fallback: () => void): void {
  if (canGoBack(navHistoryStore.getState())) historyBack()
  else fallback()
}

/** The entry Back would go to, for a caller that wants to know before it steps. */
export function previousSpot(): Spot | null {
  const h = navHistoryStore.getState()
  return canGoBack(h) ? (h.entries[h.index - 1] ?? null) : null
}

// Mouse buttons 4 and 5 (the shell page keeps no page history of its own to lose).
const BUTTON_BACK = 3
const BUTTON_FORWARD = 4

function onMouseButton(e: MouseEvent): void {
  if (e.button !== BUTTON_BACK && e.button !== BUTTON_FORWARD) return
  e.preventDefault()
  if (e.type === 'mouseup') runAction(e.button === BUTTON_BACK ? 'history-back' : 'history-forward')
}

/** Idempotent. Starts the history, its two actions (the shortcuts) and the mouse buttons. */
export function startNavHistory(): () => void {
  if (started) return started
  const live = createActor(
    navHistoryMachine.provide({ actions: { restore: (_, p) => applySpot(p.spot) } }),
  )
  actor = live
  live.subscribe((s) => {
    if (navHistoryStore.getState() !== s.context.history) {
      navHistoryStore.setState(s.context.history, true)
    }
  })
  live.start()
  lastKey = ''
  const offs = [
    registerAction('history-back', historyBack),
    registerAction('history-forward', historyForward),
    tabsStore.subscribe(observe),
    tilingStore.subscribe(observe),
  ]
  for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) {
    window.addEventListener(type, onMouseButton, true)
  }
  observe()
  const stop = (): void => {
    offs.forEach((off) => off())
    for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) {
      window.removeEventListener(type, onMouseButton, true)
    }
    live.stop()
    actor = null
    started = null
  }
  started = stop
  return stop
}

/** Test seam. */
export function resetNavHistoryForTests(): void {
  started?.()
  lastKey = ''
  navHistoryStore.setState(emptyHistory(), true)
}
