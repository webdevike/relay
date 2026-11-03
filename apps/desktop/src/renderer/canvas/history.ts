/** Undo and redo over board snapshots, one step per user action (native FlowState push_undo). */

export interface Snapshot<T> {
  /** Compares two snapshots; a step equal to the last one is not recorded. */
  key: string
  value: T
}

export interface History<T> {
  past: Array<Snapshot<T>>
  future: Array<Snapshot<T>>
}

export const HISTORY_LIMIT = 100

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] }
}

/** Records the state before an action; clears redo. */
export function record<T>(h: History<T>, before: Snapshot<T>): History<T> {
  if (h.past.at(-1)?.key === before.key) return h.future.length ? { ...h, future: [] } : h
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), future: [] }
}

/** Steps back from `current`; null when there is nothing to undo. */
export function undo<T>(
  h: History<T>,
  current: Snapshot<T>,
): { history: History<T>; state: T } | null {
  const prev = h.past.at(-1)
  if (!prev) return null
  return {
    history: { past: h.past.slice(0, -1), future: [...h.future, current] },
    state: prev.value,
  }
}

/** Steps forward from `current`; null when there is nothing to redo. */
export function redo<T>(
  h: History<T>,
  current: Snapshot<T>,
): { history: History<T>; state: T } | null {
  const next = h.future.at(-1)
  if (!next) return null
  return {
    history: { past: [...h.past, current].slice(-HISTORY_LIMIT), future: h.future.slice(0, -1) },
    state: next.value,
  }
}
