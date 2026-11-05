import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  activeTab,
  back,
  closeOthers,
  closeTab,
  defaultTabs,
  forward,
  loadTabs,
  navigate,
  openNewChat,
  routeTo,
  saveTabs,
  switchTo,
  togglePin,
  placeOf,
  type Place,
  type Tabs,
} from '@evaos/shell-core'
import type { InvokeInput } from '@evaos/contract'
import { invoke } from '../ipc'
import { registerAction } from '../hotkeys/router'
import { setNavigator, type OpenPlaceOptions } from '../navigation/navigate'
import { isFrontBare, workspaceOfTab } from './workspace-of'

/**
 * The app tabs: each a chat or a page with its own history, shown as a pane tab (tiling/ keeps
 * where). `active` is the app tab in front: the one focused last, whose place the browser scope,
 * the context popover and the sidebar's selection follow.
 */
export interface TabsState {
  tabs: Tabs
  loaded: boolean
}

export const tabsStore = createStore<TabsState>(() => ({ tabs: defaultTabs(), loaded: false }))

export function useTabs<T>(selector: (s: TabsState) => T): T {
  return useStore(tabsStore, selector)
}

export const activePlace = (s: TabsState): Place => activeTab(s.tabs).here
export const activeTabId = (s: TabsState): number => activeTab(s.tabs).id

/** Applies a tabs reducer (shell-core tabs.ts); an unchanged result leaves the store alone. */
export function updateTabs(fn: (t: Tabs) => Tabs): void {
  const cur = tabsStore.getState().tabs
  const next = fn(cur)
  if (next !== cur) tabsStore.setState({ tabs: next })
}

/**
 * Shows `place` without moving a tab that holds anything to another workspace (shell-core
 * routeTo): its open tab comes forward, a session of the assistant in front opens beside its
 * thread, another workspace's place shows in that workspace (taking the tab in front along when
 * its workspace is nothing but that tab).
 */
export function navigateTo(place: Place, opts?: OpenPlaceOptions): void {
  updateTabs((t) =>
    routeTo(t, place, {
      wsOf: workspaceOfTab,
      front: workspaceOfTab(activeTab(t)),
      reuse: isFrontBare(),
      ...(opts?.newTab ? { newTab: true } : {}),
    }),
  )
}

/** Points app tab `id` (the active one by default) at `place` without adding history. */
export function replaceTabPlace(place: Place, id?: number): void {
  updateTabs((t) => {
    const target = id ?? activeTab(t).id
    if (!t.list.some((x) => x.id === target)) return t
    return { ...t, list: t.list.map((x) => (x.id === target ? { ...x, here: place } : x)) }
  })
}

export const newChatTab = (): void => updateTabs(openNewChat)
export const activate = (id: number): void => updateTabs((t) => switchTo(t, id))
export const close = (id: number): void => updateTabs((t) => closeTab(t, id))
export const closeOthersOf = (id: number): void => updateTabs((t) => closeOthers(t, id))
export const togglePinOf = (id: number): void => updateTabs((t) => togglePin(t, id))
/** Back and Forward in app tab `id`'s history (the active one by default). */
export function goBack(id?: number): void {
  stepIn(id, back)
}
export function goForward(id?: number): void {
  stepIn(id, forward)
}

/**
 * Steps tab `id` through its history. A step into another workspace leaves this tab as it is and
 * shows that place in its own workspace, unless the tab is all its workspace holds and the other
 * has no tab yet: then the tab steps there, history and all.
 */
function stepIn(id: number | undefined, step: (t: Tabs) => Tabs): void {
  updateTabs((t) => {
    const at = id === undefined ? t.active : t.list.findIndex((x) => x.id === id)
    if (at < 0) return t
    const moved = step({ ...t, active: at })
    if (moved.list === t.list) return t
    const before = t.list[at]!
    const after = moved.list[at]!
    const ws = workspaceOfTab(before)
    const target = workspaceOfTab(after)
    if (target === ws) return moved
    const taken = t.list.some((x) => x.id !== before.id && workspaceOfTab(x) === target)
    if (at === t.active && isFrontBare() && !taken) return moved
    return routeTo({ ...t, active: at }, after.here, { wsOf: workspaceOfTab, front: ws })
  })
}

const SAVE_DELAY = 250
let started: (() => void) | null = null
let flushNow: () => void = () => {}

/** Writes a pending debounced tab save immediately (quit, pagehide). No-op when nothing is queued. */
export function flushPendingTabs(): void {
  flushNow()
}

/** Idempotent. Loads layout.json tabs, binds the navigator, registers actions, persists changes. */
export function startTabs(): () => void {
  if (started) return started
  setNavigator(navigateTo)
  const offs = [
    registerAction('history-back', () => goBack()),
    registerAction('history-forward', () => goForward()),
  ]

  let lastSaved = JSON.stringify(saveTabs(tabsStore.getState().tabs))
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = (): void => {
    timer = null
    const saved = saveTabs(tabsStore.getState().tabs)
    const json = JSON.stringify(saved)
    if (json === lastSaved) return
    lastSaved = json
    // invoke resolves to a Result and never rejects: a rejected save must reset lastSaved so the
    // next change retries instead of treating the unsaved JSON as persisted.
    try {
      void Promise.resolve(
        invoke('layout.save', { tabs: saved as InvokeInput<'layout.save'>['tabs'] }),
      ).then(
        (r) => {
          if (!r.ok) lastSaved = ''
        },
        () => {
          lastSaved = ''
        },
      )
    } catch {
      lastSaved = ''
    }
  }

  flushNow = (): void => {
    if (!timer) return
    clearTimeout(timer)
    flush()
  }
  const onPageHide = (): void => flushNow()
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide)

  const unsub = tabsStore.subscribe((s, prev) => {
    if (!s.loaded || s.tabs === prev.tabs) return
    if (JSON.stringify(saveTabs(s.tabs)) === lastSaved) return
    clearTimeout(timer ?? undefined)
    timer = setTimeout(flush, SAVE_DELAY)
  })

  void (async () => {
    let tabs: Tabs | null = null
    let needsSetup = false
    try {
      const [layout, info] = await Promise.all([invoke('layout.load', {}), invoke('app.info', {})])
      if (layout.ok) tabs = loadTabs(layout.value.tabs)
      needsSetup = info.ok && info.value.setupComplete === false
    } catch {
      // fall through to defaults
    }
    if (disposed) return
    if (needsSetup) {
      // First run of a new home base: the setup wizard replaces the default Dashboard tab.
      const opened = navigate(defaultTabs(), placeOf('setup'))
      tabs = { ...opened, list: opened.list.map((t) => ({ ...t, back: [], forward: [] })) }
    }
    if (tabs) {
      lastSaved = JSON.stringify(saveTabs(tabs))
      tabsStore.setState({ tabs, loaded: true })
    } else {
      tabsStore.setState({ loaded: true })
    }
  })()

  const dispose = (): void => {
    disposed = true
    unsub()
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide)
    flushNow = () => {}
    clearTimeout(timer ?? undefined)
    offs.forEach((o) => o())
    setNavigator(null)
    started = null
  }
  started = dispose
  return dispose
}

/** Test seam. */
export function resetTabsForTests(): void {
  started?.()
  tabsStore.setState({ tabs: defaultTabs(), loaded: false }, true)
}
