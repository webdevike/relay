import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type {
  SpecialistAgents,
  SpecialistFolder,
  SpecialistRuns,
  SpecialistSaved,
} from '@evaos/contract'
import { invoke, on } from '../ipc'
import { openFile, openRoot } from '../files/files-store'

export type AgentTab = 'files' | 'runs'

/**
 * The Agents page: the atomic-agents specialists as the service loads them, and the one whose
 * files and runs are open. Main reads the service's CLI; this store asks on mount, whenever the
 * service's journal changes (a run started or ended, a save landed) and on a timer.
 */
export interface SpecialistsState {
  roster: SpecialistAgents | null
  error: string | null
  /** The agent whose detail is open; null shows the list. */
  agent: string | null
  tab: AgentTab
  /** Each opened agent's newest runs. */
  runs: Record<string, SpecialistRuns>
  runsError: string | null
  /** The run whose output the side panel shows. */
  run: string | null
  /** The run panel is folded to a strip. */
  collapsed: boolean
  /** Each opened agent's folder as a Files root, or why it did not open. */
  folders: Record<string, SpecialistFolder | { error: string }>
  /** Each agent's last save: committed, or why not. */
  saved: Record<string, SpecialistSaved>
}

export const specialistsStore = createStore<SpecialistsState>(() => ({
  roster: null,
  error: null,
  agent: null,
  tab: 'files',
  runs: {},
  runsError: null,
  run: null,
  collapsed: false,
  folders: {},
  saved: {},
}))

export function useSpecialists<T>(selector: (s: SpecialistsState) => T): T {
  return useStore(specialistsStore, selector)
}

const POLL_MS = 30_000
const CHANGED_SETTLE_MS = 400

let latestRoster = 0
export async function refreshRoster(): Promise<void> {
  const ask = ++latestRoster
  const r = await invoke('agents.roster', {})
  if (ask !== latestRoster) return
  if (r.ok) specialistsStore.setState({ roster: r.value, error: null })
  else specialistsStore.setState({ error: r.error.message })
}

let latestRuns = 0
export async function refreshAgentRuns(agent: string): Promise<void> {
  const ask = ++latestRuns
  const r = await invoke('agents.agentRuns', { agent })
  if (ask !== latestRuns) return
  if (r.ok)
    specialistsStore.setState((s) => ({ runs: { ...s.runs, [agent]: r.value }, runsError: null }))
  else specialistsStore.setState({ runsError: r.error.message })
}

/** Opens `agent`'s folder as a Files root, on its AGENT.md (or spec) the first time. */
export async function openAgentFolder(agent: string): Promise<void> {
  const r = await invoke('agents.agentFolder', { agent })
  if (!r.ok) {
    specialistsStore.setState((s) => ({
      folders: { ...s.folders, [agent]: { error: r.error.message } },
    }))
    return
  }
  const before = specialistsStore.getState().folders[agent]
  const first = before === undefined || 'error' in before
  openRoot(r.value.root, r.value.name)
  specialistsStore.setState((s) => ({ folders: { ...s.folders, [agent]: r.value } }))
  if (first) openFile(r.value.root, r.value.entry, { pin: true })
}

let watchers = 0
let stop: (() => void) | null = null

/** Follows the agents while the page is mounted: now, on every journal change and save, and every POLL_MS. */
export function startSpecialists(): () => void {
  if (watchers++ === 0) {
    let settle: number | undefined
    const changed = (): void => {
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        void refreshRoster()
        const { agent, tab } = specialistsStore.getState()
        if (agent !== null && tab === 'runs') void refreshAgentRuns(agent)
      }, CHANGED_SETTLE_MS)
    }
    const offChanged = on('agents.specialistsChanged', changed)
    const offSaved = on('agents.agentSaved', (saved) => {
      specialistsStore.setState((s) => ({ saved: { ...s.saved, [saved.agent]: saved } }))
      changed()
    })
    const timer = window.setInterval(() => void refreshRoster(), POLL_MS)
    stop = () => {
      offChanged()
      offSaved()
      window.clearInterval(timer)
      window.clearTimeout(settle)
    }
    void refreshRoster()
  }
  return () => {
    if (--watchers === 0) {
      stop?.()
      stop = null
    }
  }
}

/** Opens an agent's detail (null: back to the list); a deep link names one. */
export function openAgent(agent: string | null, tab: AgentTab = 'files'): void {
  specialistsStore.setState({ agent, tab, run: null, collapsed: false })
  if (agent === null) return
  if (tab === 'files') void openAgentFolder(agent)
  else void refreshAgentRuns(agent)
}

export function setAgentTab(tab: AgentTab): void {
  const { agent } = specialistsStore.getState()
  specialistsStore.setState({ tab })
  if (agent === null) return
  if (tab === 'runs') void refreshAgentRuns(agent)
  else void openAgentFolder(agent)
}

export function selectRun(run: string | null): void {
  specialistsStore.setState({ run, collapsed: false })
}

export function collapseRunPanel(collapsed: boolean): void {
  specialistsStore.setState({ collapsed })
}

/** Test seam. */
export function resetSpecialistsForTests(): void {
  stop?.()
  stop = null
  watchers = 0
  specialistsStore.setState({
    roster: null,
    error: null,
    agent: null,
    tab: 'files',
    runs: {},
    runsError: null,
    run: null,
    collapsed: false,
    folders: {},
    saved: {},
  })
}
