import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { AgentRunOp, AgentRunStatus, CanvasRun } from '@evaos/contract'
import { invoke, on } from '../../ipc'

/** Every board an agent works or worked, as main last sent them. */
export const canvasRunsStore = createStore<{ runs: CanvasRun[] }>(() => ({ runs: [] }))

export function useCanvasRuns<T>(selector: (s: { runs: CanvasRun[] }) => T): T {
  return useStore(canvasRunsStore, selector)
}

/** The run on board `slug` that shows (ring, caption row), else null. */
export function shownRun(runs: readonly CanvasRun[], slug: string | null): CanvasRun | null {
  return runs.find((r) => r.slug === slug && r.status !== 'idle') ?? null
}

/**
 * Whether an edit of Isaac's on the board takes it over from the agent: only while the agent acts
 * there or waits on his Allow. Paused, finished and idle runs are his already.
 */
export function takesOver(status: AgentRunStatus | undefined): boolean {
  return status === 'working' || status === 'ask'
}

/** Isaac's control on the agent's run on board `slug` (Take over, Hand back, Allow, dismiss). */
export async function canvasAgentOp(slug: string, op: AgentRunOp): Promise<boolean> {
  return (await invoke('canvas.agent', { slug, op })).ok
}

/** Loads the runs once and follows main's pushes. */
export function startCanvasRuns(): () => void {
  const off = on('canvas.runs', ({ runs }) => canvasRunsStore.setState({ runs }))
  void invoke('canvas.runs', {}).then((r) => {
    if (r.ok) canvasRunsStore.setState({ runs: r.value.runs })
  })
  return off
}
