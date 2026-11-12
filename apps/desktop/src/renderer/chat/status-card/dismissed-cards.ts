import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { DismissedCardsView } from '@evaos/contract'
import { invoke, on } from '../../ipc'

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

interface DismissedState {
  /** Dismissed on this device (localStorage). */
  local: readonly string[]
  /** The host's set, once it keeps one and has sent it; null otherwise. */
  host: readonly string[] | null
  /** Dismissed here since the host's last snapshot, shown before it echoes them. */
  pending: readonly string[]
  /** What the hooks return: the host's set plus `pending` when the host's is known, else `local`. */
  ids: readonly string[]
}

function shown(s: Pick<DismissedState, 'local' | 'host' | 'pending'>): readonly string[] {
  if (s.host === null) return s.local
  const host = s.host
  return [...host, ...s.pending.filter((id) => !host.includes(id))]
}

function withIds(s: Omit<DismissedState, 'ids'>): DismissedState {
  return { ...s, ids: shown(s) }
}

const store = createStore<DismissedState>(() => {
  const local = load()
  return withIds({ local, host: null, pending: [] })
})

/** Whether this window already sent its local dismissals up to the host. */
let uploaded = false

/** Hides card `id` for good (this device, across reloads; the phone too when the host keeps the set). */
export function dismissCard(id: string): void {
  const s = store.getState()
  const local = s.local.includes(id) ? s.local : [...s.local, id].slice(-MAX_KEPT)
  if (local !== s.local) save(local)
  if (s.host === null) {
    if (local !== s.local) store.setState(withIds({ ...s, local }))
    return
  }
  if (s.host.includes(id) || s.pending.includes(id)) return
  store.setState(withIds({ ...s, local, pending: [...s.pending, id] }))
  void invoke('cards.dismiss', { id, on: true })
}

/** The host's dismissed set (`up` and a snapshot received), or null: this device's own set rules. */
function applyHost(view: DismissedCardsView): void {
  const s = store.getState()
  const ids = view.up ? view.ids : null
  if (ids === null) {
    if (s.host !== null) store.setState(withIds({ ...s, host: null, pending: [] }))
    return
  }
  store.setState(withIds({ ...s, host: ids, pending: s.pending.filter((id) => !ids.includes(id)) }))
  if (uploaded) return
  uploaded = true
  for (const id of s.local) {
    if (!ids.includes(id)) void invoke('cards.dismiss', { id, on: true })
  }
}

/** Follows main's pushes of the host's set, and asks for it now. Ids ending `#running` come from the phone and match no card here; they just stay in the set. */
export function startDismissedCards(): () => void {
  const off = on('cards.dismissed.changed', applyHost)
  void invoke('cards.dismissed.get', {}).then((r) => {
    if (r.ok) applyHost(r.value)
  })
  return off
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
  uploaded = false
  store.setState(withIds({ local: load(), host: null, pending: [] }))
}
