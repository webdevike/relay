import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

/** A session transcript a chat pane was swapped to in place (a chip's plain click). */
export interface DrillEntry {
  /** The transcript's `.jsonl` path on this machine. */
  file: string
  title: string
  model?: string
  /** When it started, for the elapsed time in the breadcrumb's tooltip. */
  startedAt?: number
}

/** Per chat pane: the transcripts drilled into, outermost first. Empty shows the pane's own chat. */
const store = createStore<{ trails: Record<string, readonly DrillEntry[]> }>(() => ({ trails: {} }))

const NONE: readonly DrillEntry[] = []

export const drillStore = {
  getState: (paneId: string): readonly DrillEntry[] => store.getState().trails[paneId] ?? NONE,
  /** Opens `entry` over the pane's current view; the one already in front is not stacked twice. */
  push(paneId: string, entry: DrillEntry): void {
    const trail = drillStore.getState(paneId)
    if (trail[trail.length - 1]?.file === entry.file) return
    store.setState((s) => ({ trails: { ...s.trails, [paneId]: [...trail, entry] } }))
  },
  /** Keeps the first `depth` entries: 0 returns to the thread the pane came from. */
  popTo(paneId: string, depth: number): void {
    store.setState((s) => {
      const { [paneId]: trail, ...rest } = s.trails
      if (trail === undefined) return s
      return depth <= 0
        ? { trails: rest }
        : { trails: { ...rest, [paneId]: trail.slice(0, depth) } }
    })
  },
}

export function useDrillTrail(paneId: string): readonly DrillEntry[] {
  return useStore(store, (s) => s.trails[paneId] ?? NONE)
}
