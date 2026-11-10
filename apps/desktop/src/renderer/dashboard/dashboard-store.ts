import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { DashboardPayload } from '@evaos/contract'
import type { FilterId } from '@evaos/eva-core/model/dashboard'
import { invoke } from '../ipc'
import { setWorkspaceNames } from '../eva/names-store'
import { bindPref, parseOneOf } from '../ui-prefs'

export type Range = 7 | 30 | 90

export interface DashboardState {
  data: DashboardPayload | null
  loading: boolean
  error: boolean
  reloading: boolean
  filter: FilterId
  range: Range
}

const initial = (): DashboardState => ({
  data: null,
  loading: true,
  error: false,
  reloading: false,
  filter: 'all',
  range: 7,
})

export const dashboardStore = createStore<DashboardState>(initial)

export const RANGES: readonly Range[] = [7, 30, 90]
const FILTERS: readonly FilterId[] = ['all', 'active', 'todos', 'quiet']
bindPref(dashboardStore, 'dashboard.filter', {
  select: (s) => s.filter,
  apply: (filter) => ({ filter }),
  parse: parseOneOf(FILTERS),
})
bindPref(dashboardStore, 'dashboard.range', {
  select: (s) => s.range,
  apply: (range) => ({ range }),
  parse: parseOneOf(RANGES),
})

export function useDashboard<T>(selector: (s: DashboardState) => T): T {
  return useStore(dashboardStore, selector)
}

export const setFilter = (filter: FilterId): void => dashboardStore.setState({ filter })
export const setRange = (range: Range): void => dashboardStore.setState({ range })

export function workspaceName(id: string): string | null {
  return dashboardStore.getState().data?.workspaces.find((w) => w.id === id)?.displayName ?? null
}

let inflight: Promise<void> | null = null
let queued = false

async function runOnce(): Promise<void> {
  dashboardStore.setState({ reloading: true })
  try {
    const r = await invoke('eva.dashboard', {})
    if (r.ok) {
      dashboardStore.setState({ data: r.value, error: false, loading: false })
      setWorkspaceNames(Object.fromEntries(r.value.workspaces.map((w) => [w.id, w.displayName])))
    } else dashboardStore.setState({ error: true, loading: false })
  } catch {
    dashboardStore.setState({ error: true, loading: false })
  } finally {
    dashboardStore.setState({ reloading: false })
  }
}

/** One request in flight; any triggers during flight collapse into exactly one follow-up (T-03-29). */
export function loadDashboard(): Promise<void> {
  if (inflight) {
    queued = true
    return inflight
  }
  inflight = (async () => {
    try {
      do {
        queued = false
        await runOnce()
      } while (queued)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function resetDashboardForTests(): void {
  inflight = null
  queued = false
  dashboardStore.setState(initial(), true)
}
