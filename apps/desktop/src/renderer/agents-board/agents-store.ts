import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { AgentBoard, SpecialistRuns } from '@evaos/contract'
import { invoke, on } from '../ipc'
import { bindPref, parseBool, parseOneOf, parseString } from '../ui-prefs'
import { DEFAULT_FILTERS, type BoardFilters, type GroupBy } from './board-view'

/** The Agents page's two views: the work board, and the specialist runs assistants asked for. */
export type AgentsView = 'board' | 'specialists'

/**
 * The Agents page's state. Main builds every board; this store asks for one when the page
 * mounts, whenever main says a source changed, and on a timer (so gh and Linear, which main
 * refreshes in the background on those asks, keep landing). Specialist runs come the same way
 * (on mount, then on the timer) while their view is open.
 */
export interface AgentsBoardState {
  view: AgentsView
  board: AgentBoard | null
  error: string | null
  /** The card whose side panel is open. */
  selected: string | null
  /** The panel is folded to a strip beside the board; opening a card unfolds it. */
  collapsed: boolean
  filters: BoardFilters
  specialists: SpecialistRuns | null
  specialistsError: string | null
  /** The specialist run whose reply the side panel shows. */
  run: string | null
}

export const agentsBoardStore = createStore<AgentsBoardState>(() => ({
  view: 'board',
  board: null,
  error: null,
  selected: null,
  collapsed: false,
  filters: DEFAULT_FILTERS,
  specialists: null,
  specialistsError: null,
  run: null,
}))

export function useAgentsBoard<T>(selector: (s: AgentsBoardState) => T): T {
  return useStore(agentsBoardStore, selector)
}

const POLL_MS = 30_000

let latest = 0

export async function refreshAgentsBoard(): Promise<void> {
  const ask = ++latest
  const r = await invoke('agents.board', {})
  if (ask !== latest) return
  if (r.ok) agentsBoardStore.setState({ board: r.value, error: null })
  else agentsBoardStore.setState({ error: r.error.message })
}

let watchers = 0
let stop: (() => void) | null = null

/** Follows the board while the page is mounted: now, on every `agents.changed`, and every POLL_MS. */
export function startAgentsBoard(): () => void {
  if (watchers++ === 0) {
    const off = on('agents.changed', () => void refreshAgentsBoard())
    const timer = window.setInterval(() => void refreshAgentsBoard(), POLL_MS)
    stop = () => {
      off()
      window.clearInterval(timer)
    }
    void refreshAgentsBoard()
  }
  return () => {
    if (--watchers === 0) {
      stop?.()
      stop = null
    }
  }
}

let latestRuns = 0

export async function refreshSpecialists(): Promise<void> {
  const ask = ++latestRuns
  const r = await invoke('agents.specialists', {})
  if (ask !== latestRuns) return
  if (r.ok) agentsBoardStore.setState({ specialists: r.value, specialistsError: null })
  else agentsBoardStore.setState({ specialistsError: r.error.message })
}

/** Follows the specialist runs while their view is mounted: now, and every POLL_MS. */
export function startSpecialists(): () => void {
  const timer = window.setInterval(() => void refreshSpecialists(), POLL_MS)
  void refreshSpecialists()
  return () => window.clearInterval(timer)
}

export function setAgentsView(view: AgentsView): void {
  agentsBoardStore.setState({ view })
}

export function setBoardFilters(patch: Partial<BoardFilters>): void {
  agentsBoardStore.setState((s) => ({ filters: { ...s.filters, ...patch } }))
}

export function selectCard(id: string | null): void {
  agentsBoardStore.setState({ selected: id, collapsed: false })
}

export function selectRun(run: string | null): void {
  agentsBoardStore.setState({ run, collapsed: false })
}

export function collapsePanel(collapsed: boolean): void {
  agentsBoardStore.setState({ collapsed })
}

// The view, the panel fold and the filters are the user's choices: kept in layout.json. The
// search words are a draft and start empty.
const VIEWS: readonly AgentsView[] = ['board', 'specialists']
bindPref(agentsBoardStore, 'agents.view', {
  select: (s) => s.view,
  apply: (view) => ({ view }),
  parse: parseOneOf(VIEWS),
})

const GROUPS: readonly GroupBy[] = ['none', 'agent', 'workspace']
type SavedFilters = Omit<BoardFilters, 'query'>
const parseFilters = (raw: unknown): SavedFilters | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  return {
    agent: parseString(r['agent']),
    workspace: parseString(r['workspace']),
    showStale: parseBool(r['showStale']) ?? DEFAULT_FILTERS.showStale,
    group: parseOneOf(GROUPS)(r['group']) ?? DEFAULT_FILTERS.group,
  }
}
bindPref(agentsBoardStore, 'agents.collapsed', {
  select: (s) => s.collapsed,
  apply: (collapsed) => ({ collapsed }),
  parse: parseBool,
})
bindPref<AgentsBoardState, SavedFilters>(agentsBoardStore, 'agents.filters', {
  select: ({ filters: { agent, workspace, showStale, group } }) => ({
    agent,
    workspace,
    showStale,
    group,
  }),
  apply: (f) => ({ filters: { ...agentsBoardStore.getState().filters, ...f } }),
  parse: parseFilters,
  same: (a, b) =>
    a.agent === b.agent &&
    a.workspace === b.workspace &&
    a.showStale === b.showStale &&
    a.group === b.group,
})
