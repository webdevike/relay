import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  activeTab,
  back,
  closeActive,
  closeOthers,
  closeTab,
  defaultTabs,
  forkTab,
  forward,
  loadTabs,
  navigate,
  openNewChat,
  saveTabs,
  switchTo,
  togglePin,
  type Place,
  type Tabs,
} from '@evaos/shell-core'
import type { InvokeInput } from '@evaos/contract'
import { invoke } from '../ipc'
import { registerAction } from '../hotkeys/router'
import { setNavigator, type OpenPlaceOptions } from '../navigation/navigate'

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

function update(fn: (t: Tabs) => Tabs): void {
  const cur = tabsStore.getState().tabs
  const next = fn(cur)
  if (next !== cur) tabsStore.setState({ tabs: next })
}

export function navigateTo(place: Place, opts?: OpenPlaceOptions): void {
  update((t) => (opts?.newTab ? navigate(forkTab(t), place) : navigate(t, place)))
}

export const newChatTab = (): void => update(openNewChat)
export const activate = (id: number): void => update((t) => switchTo(t, id))
export const close = (id: number): void => update((t) => closeTab(t, id))
export const closeOthersOf = (id: number): void => update((t) => closeOthers(t, id))
export const togglePinOf = (id: number): void => update((t) => togglePin(t, id))

const SAVE_DELAY = 250
let started: (() => void) | null = null

/** Idempotent. Loads layout.json tabs, binds the navigator, registers actions, persists changes. */
export function startTabs(): () => void {
  if (started) return started
  setNavigator(navigateTo)
  const offs = [
    registerAction('new-tab', newChatTab),
    registerAction('close-tab', () => update(closeActive)),
    registerAction('history-back', () => update(back)),
    registerAction('history-forward', () => update(forward)),
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

  const unsub = tabsStore.subscribe((s, prev) => {
    if (!s.loaded || s.tabs === prev.tabs) return
    if (JSON.stringify(saveTabs(s.tabs)) === lastSaved) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, SAVE_DELAY)
  })

  void (async () => {
    let tabs: Tabs | null = null
    try {
      const r = await invoke('layout.load', {})
      if (r.ok) tabs = loadTabs(r.value.tabs)
    } catch {
      // fall through to defaults
    }
    if (disposed) return
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
    if (timer) clearTimeout(timer)
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
