import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { setDirtyHooks } from '../hotkeys/e2e-hooks'

export interface DirtyEntry {
  label: string
  save: () => Promise<void> | void
}

export interface DirtyFailure {
  id: string
  label: string
  message: string
}

/** The one registry for unsaved edits (D-18). Insertion order is registration order. */
export const dirtyStore = createStore<{ entries: Map<string, DirtyEntry> }>(() => ({
  entries: new Map(),
}))

export function registerDirty(id: string, entry: DirtyEntry): () => void {
  dirtyStore.setState((s) => ({ entries: new Map(s.entries).set(id, entry) }))
  return () => {
    dirtyStore.setState((s) => {
      if (s.entries.get(id) !== entry) return s
      const entries = new Map(s.entries)
      entries.delete(id)
      return { entries }
    })
  }
}

export function listDirty(): Array<{ id: string; label: string }> {
  return [...dirtyStore.getState().entries].map(([id, e]) => ({ id, label: e.label }))
}

export async function saveAllDirty(): Promise<DirtyFailure[]> {
  const failures: DirtyFailure[] = []
  for (const [id, e] of [...dirtyStore.getState().entries]) {
    try {
      await e.save()
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500)
      failures.push({ id, label: e.label, message })
    }
  }
  return failures
}

export function useDirtyCount(): number {
  return useStore(dirtyStore, (s) => s.entries.size)
}

let e2eSeq = 0
let e2eSaves = 0
const e2eUnregister = new Map<string, () => void>()
setDirtyHooks({
  mark(label) {
    const id = `e2e-dirty-${++e2eSeq}`
    e2eUnregister.set(
      id,
      registerDirty(id, {
        label,
        save: () => {
          e2eSaves++
        },
      }),
    )
    return id
  },
  saves: () => e2eSaves,
  clear(id) {
    e2eUnregister.get(id)?.()
    e2eUnregister.delete(id)
  },
})
