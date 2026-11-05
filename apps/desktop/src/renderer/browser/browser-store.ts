import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { notifications } from '@mantine/notifications'
import type { TabState, TabsSnapshot } from '@evaos/contract'
import { invoke, on } from '../ipc'
import { recordPage } from '../tiling/recent'
import { startWebTabs } from '../tiling/web-tabs'
import { startSessionPages } from './session-pages'

export interface BrowserState {
  /** The browser scope on screen's tabs (the workspace on screen's): pinned first, then its own. */
  tabs: TabState[]
  /** The host's active tab: the page last focused (its extension actions, keys it forwards). */
  activeId: string
  scope: string
  /** Every page known by id: the scope's, plus pages read by id (another scope's page tab). */
  byId: Record<string, TabState>
  /** The page tab whose address field takes the focus once it shows (a new blank page). */
  wantAddress: string | null
  set(s: TabsSnapshot): void
  put(tabs: readonly TabState[]): void
}

export const browserStore = createStore<BrowserState>((set, get) => ({
  tabs: [],
  activeId: '',
  scope: '',
  byId: {},
  wantAddress: null,
  set: (s) => {
    const prev = get()
    const byId = { ...prev.byId }
    // A page that left the same scope's list is closed.
    if (prev.scope === s.scope) {
      const live = new Set(s.tabs.map((t) => t.id))
      for (const t of prev.tabs) if (!live.has(t.id)) delete byId[t.id]
    }
    for (const t of s.tabs) byId[t.id] = t
    set({ tabs: s.tabs, activeId: s.activeId, scope: s.scope, byId })
    const front = s.tabs.find((t) => t.id === s.activeId)
    if (front && !front.blank && !front.loading && !front.error) recordPage(front.url, front.title)
  },
  put: (tabs) => {
    if (tabs.length === 0) return
    const byId = { ...get().byId }
    for (const t of tabs) byId[t.id] = t
    set({ byId })
  },
}))

export function useBrowserStore<T>(sel: (s: BrowserState) => T): T {
  return useStore(browserStore, sel)
}

/** Page `id`'s state, for its page tab. */
export function useWebPage(id: string): TabState | undefined {
  return useStore(browserStore, (s) => s.byId[id])
}

/** Reads pages the scope on screen does not list (another scope's page tabs) into `byId`. */
export async function readPages(ids: readonly string[]): Promise<void> {
  const missing = ids.filter((id) => !browserStore.getState().byId[id])
  if (missing.length === 0) return
  const r = await invoke('browser.tabs.get', { ids: missing.slice(0, 64) })
  if (r.ok) browserStore.getState().put(r.value.tabs)
}

/** Page `id`'s address field takes the focus once its tab shows. */
export function focusAddressOf(id: string): void {
  browserStore.setState({ wantAddress: id })
}

/**
 * Loads the current tabs and follows `browser.tabs` and `browser.notice`, then starts the page
 * tabs (web-tabs: popups, the host's active page, the retired Browser panel) and the offer to
 * close a finished session's pages. Returns the unsubscribe.
 */
export function startBrowserStore(): () => void {
  const offTabs = on('browser.tabs', (p) => browserStore.getState().set(p))
  const offNotice = on('browser.notice', (p) =>
    notifications.show({ message: p.message, autoClose: 4000 }),
  )
  void invoke('browser.state', {}).then((r) => {
    if (r.ok) browserStore.getState().set(r.value)
  })
  const offWeb = startWebTabs()
  const offSessions = startSessionPages()
  return () => {
    offTabs()
    offNotice()
    offWeb()
    offSessions()
  }
}

export function activeTab(s: BrowserState): TabState | undefined {
  return s.tabs.find((t) => t.id === s.activeId)
}
