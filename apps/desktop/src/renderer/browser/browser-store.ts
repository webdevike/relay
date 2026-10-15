import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { TabState, TabsSnapshot } from '@evaos/contract'
import { invoke, on } from '../ipc'

export interface BrowserState {
  tabs: TabState[]
  activeId: string
  set(s: TabsSnapshot): void
}

export const browserStore = createStore<BrowserState>((set) => ({
  tabs: [],
  activeId: '',
  set: (s) => set({ tabs: s.tabs, activeId: s.activeId }),
}))

export function useBrowserStore<T>(sel: (s: BrowserState) => T): T {
  return useStore(browserStore, sel)
}

/** Loads the current tabs and follows `browser.tabs` events; returns the unsubscribe. */
export function startBrowserStore(): () => void {
  const off = on('browser.tabs', (p) => browserStore.getState().set(p))
  void invoke('browser.state', {}).then((r) => {
    if (r.ok) browserStore.getState().set(r.value)
  })
  return off
}

export function activeTab(s: BrowserState): TabState | undefined {
  return s.tabs.find((t) => t.id === s.activeId)
}
