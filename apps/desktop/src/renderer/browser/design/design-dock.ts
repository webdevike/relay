import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

/**
 * Where Design Mode's inspector sits in its page tab, per tab for the app's lifetime. A native
 * page view paints over anything the renderer draws on its slot, so the panel can't float over the
 * page: it docks to an edge of the tab (the page keeps the rest), and dragging its header moves
 * the dock. `dragging` is the tab whose panel is being dragged: its page view parks meanwhile (the
 * native view would swallow the pointer) and the drop zones show in its place.
 */
export type Dock = 'right' | 'left' | 'top' | 'bottom'

export const DEFAULT_DOCK: Dock = 'right'

const store = createStore<{
  docks: Record<string, Dock>
  dragging: string | null
  over: Dock | null
}>(() => ({ docks: {}, dragging: null, over: null }))

/** The dock nearest `point` inside `box`: the edge whose side of the box the point leans to most. */
export function dockAt(
  box: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number },
): Dock {
  const dx = (point.x - (box.x + box.width / 2)) / Math.max(box.width, 1)
  const dy = (point.y - (box.y + box.height / 2)) / Math.max(box.height, 1)
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'top' : 'bottom'
}

export function useDock(tabId: string): Dock {
  return useStore(store, (s) => s.docks[tabId] ?? DEFAULT_DOCK)
}

export function useDragState(tabId: string): { dragging: boolean; over: Dock | null } {
  const dragging = useStore(store, (s) => s.dragging === tabId)
  const over = useStore(store, (s) => (s.dragging === tabId ? s.over : null))
  return { dragging, over }
}

export function dockOf(tabId: string): Dock {
  return store.getState().docks[tabId] ?? DEFAULT_DOCK
}

export function startDrag(tabId: string): void {
  store.setState({ dragging: tabId, over: dockOf(tabId) })
}

export function dragOver(over: Dock): void {
  if (store.getState().over !== over) store.setState({ over })
}

/** Drops the panel on the dock under the pointer (or leaves it where it was when cancelled). */
export function endDrag(tabId: string, drop: boolean): void {
  const { over } = store.getState()
  store.setState((s) => ({
    dragging: null,
    over: null,
    docks: drop && over ? { ...s.docks, [tabId]: over } : s.docks,
  }))
}
