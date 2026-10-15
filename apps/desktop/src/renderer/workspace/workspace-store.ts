import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { WorkspaceDetail } from '@evaos/contract'
import { invoke } from '../ipc'

export interface WorkspaceState {
  id: string | null
  data: WorkspaceDetail | null
  loading: boolean
  error: boolean
}

const initial = (): WorkspaceState => ({ id: null, data: null, loading: true, error: false })

export const workspaceStore = createStore<WorkspaceState>(initial)

export function useWorkspace<T>(selector: (s: WorkspaceState) => T): T {
  return useStore(workspaceStore, selector)
}

let inflight: Promise<void> | null = null
let queued = false
let wanted: string | null = null

async function runOnce(id: string): Promise<void> {
  try {
    const r = await invoke('eva.workspace', { id })
    if (wanted !== id) return
    if (r.ok) workspaceStore.setState({ id, data: r.value, error: false, loading: false })
    else workspaceStore.setState({ id, error: true, loading: false })
  } catch {
    if (wanted === id) workspaceStore.setState({ id, error: true, loading: false })
  }
}

/** One request in flight; triggers during flight collapse into exactly one follow-up. */
export function loadWorkspace(id: string): Promise<void> {
  if (wanted !== id) {
    wanted = id
    workspaceStore.setState({ id, data: null, loading: true, error: false })
  }
  if (inflight) {
    queued = true
    return inflight
  }
  inflight = (async () => {
    try {
      do {
        queued = false
        await runOnce(wanted ?? id)
      } while (queued)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function resetWorkspaceForTests(): void {
  inflight = null
  queued = false
  wanted = null
  workspaceStore.setState(initial(), true)
}
