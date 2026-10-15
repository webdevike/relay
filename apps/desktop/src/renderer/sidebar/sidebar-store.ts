import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { invoke } from '../ipc'
import { registerAction } from '../hotkeys/router'
import { layoutStore, toggleSidebar } from '../shell/layout-store'
import { focusSearch } from './nav-level'

export interface RecentItem {
  date: string
  tag: string | null
  title: string
}

export interface SidebarData {
  openTodos: number
  scheduledJobs: number
  recent: RecentItem[]
  error: boolean
  loaded: boolean
}

const initial = (): SidebarData => ({
  openTodos: 0,
  scheduledJobs: 0,
  recent: [],
  error: false,
  loaded: false,
})

export const sidebarStore = createStore<SidebarData>(initial)

export function useSidebarData<T>(selector: (s: SidebarData) => T): T {
  return useStore(sidebarStore, selector)
}

let inflight: Promise<void> | null = null

/** One in-flight call at a time (T-02-41); never throws. */
export function refreshSidebar(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const r = await invoke('eva.sidebar', {})
      if (r.ok) {
        sidebarStore.setState({
          openTodos: r.value.openTodos,
          scheduledJobs: r.value.scheduledJobs,
          recent: r.value.recent,
          error: false,
          loaded: true,
        })
      } else {
        sidebarStore.setState({ ...initial(), error: true, loaded: true })
      }
    } catch {
      sidebarStore.setState({ ...initial(), error: true, loaded: true })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function filterRecent(recent: readonly RecentItem[], query: string): RecentItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...recent]
  return recent.filter(
    (r) => r.title.toLowerCase().includes(q) || (r.tag?.toLowerCase().includes(q) ?? false),
  )
}

export function countLabel(n: number): string | null {
  if (!(n > 0)) return null
  return n > 99 ? '99+' : String(n)
}

let started: (() => void) | null = null

/** Idempotent: initial refresh, refresh on window focus and the focus-search action. The reload action lives in reload/reload.ts. */
export function startSidebar(): () => void {
  if (started) return started
  const onFocus = (): void => {
    void refreshSidebar()
  }
  window.addEventListener('focus', onFocus)
  const offFocus = registerAction('focus-search', () => {
    if (layoutStore.getState().state === 'hidden') toggleSidebar(true)
    else if (layoutStore.getState().state === 'folded') return
    focusSearch()
  })
  void refreshSidebar()
  const dispose = (): void => {
    window.removeEventListener('focus', onFocus)
    offFocus()
    started = null
  }
  started = dispose
  return dispose
}

export function resetSidebarForTests(): void {
  started?.()
  inflight = null
  sidebarStore.setState(initial(), true)
}
