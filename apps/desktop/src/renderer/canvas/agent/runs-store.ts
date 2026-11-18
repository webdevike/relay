import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { NodeChange } from '@xyflow/react'
import type { AgentRunOp, CanvasRun } from '@evaos/contract'
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

/** How often a card Isaac keeps changing renews its hold (main lets one go 3 s after his last). */
export const HOLD_REFRESH_MS = 1_000

/**
 * The cards a React Flow change list says Isaac is moving or resizing. Selection and the sizes
 * the layout gives cards are no edits; the agent's own carries set the nodes directly and never
 * come through here.
 */
export function cardsIsaacChanges(changes: readonly NodeChange[]): string[] {
  return changes.flatMap((c) =>
    c.type === 'position' || (c.type === 'dimensions' && c.resizing !== undefined) ? [c.id] : [],
  )
}

/**
 * Of `ids`, the cards whose hold is due again at `now` (never sent, or last sent HOLD_REFRESH_MS
 * ago or more); records them in `sent`.
 */
export function dueHolds(sent: Map<string, number>, ids: Iterable<string>, now: number): string[] {
  const due: string[] = []
  for (const id of new Set(ids)) {
    const at = sent.get(id)
    if (at !== undefined && now - at < HOLD_REFRESH_MS) continue
    sent.set(id, now)
    due.push(id)
  }
  return due
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
