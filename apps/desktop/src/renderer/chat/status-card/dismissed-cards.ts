import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

/** Where the dismissed cards live, so a card Isaac closed stays closed across reloads. */
export const DISMISSED_CARDS_KEY = 'relay.dismissed-status-cards'

/** The newest this many stay; an older id comes back only if its card is still around. */
const MAX_KEPT = 500

function load(): readonly string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DISMISSED_CARDS_KEY) ?? '[]')
    return Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string').slice(-MAX_KEPT)
      : []
  } catch {
    return []
  }
}

function save(ids: readonly string[]): void {
  try {
    localStorage.setItem(DISMISSED_CARDS_KEY, JSON.stringify(ids))
  } catch {
    // Storage off: the card stays closed until the window does.
  }
}

const store = createStore<{ ids: readonly string[] }>(() => ({ ids: load() }))

/** Hides card `id` for good (this device, across reloads). */
export function dismissCard(id: string): void {
  const { ids } = store.getState()
  if (ids.includes(id)) return
  const next = [...ids, id].slice(-MAX_KEPT)
  store.setState({ ids: next })
  save(next)
}

/** Whether card `id` was dismissed. */
export function useDismissed(id: string): boolean {
  return useStore(store, (s) => s.ids.includes(id))
}

/** Every dismissed card id, for a list that filters its cards before it draws them. */
export function useDismissedIds(): readonly string[] {
  return useStore(store, (s) => s.ids)
}

/** Forgets every dismissal and re-reads storage (tests). */
export function reloadDismissedForTests(): void {
  store.setState({ ids: load() })
}
