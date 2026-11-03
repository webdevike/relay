import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { Place } from '@evaos/shell-core'

export type NavLevel =
  'root' | 'assistants' | 'chats' | 'canvas' | 'settings' | 'meetings' | 'reviews'

export const navLevelStore = createStore<{ level: NavLevel }>(() => ({ level: 'root' }))

export function useNavLevel(): NavLevel {
  return useStore(navLevelStore, (s) => s.level)
}

export function openSub(level: Exclude<NavLevel, 'root'>): void {
  navLevelStore.setState({ level })
}

export function backToRoot(): void {
  navLevelStore.setState({ level: 'root' })
}

export function levelForPlace(place: Place): Exclude<NavLevel, 'root'> | null {
  if (place.page === 'assistants' || place.page.startsWith('agent:')) return 'assistants'
  if (place.page === 'chat') return 'chats'
  if (place.page === 'meetings') return 'meetings'
  if (place.page === 'reviews') return 'reviews'
  if (place.page === 'canvas') return 'canvas'
  if (place.page === 'settings') return 'settings'
  return null
}

let focuser: (() => void) | null = null

/** The visible SearchBox registers itself here; returns an unregister function. */
export function registerSearchFocuser(fn: () => void): () => void {
  focuser = fn
  return () => {
    if (focuser === fn) focuser = null
  }
}

/** Focuses the visible search on the next frame; safe with nothing registered. */
export function focusSearch(): void {
  requestAnimationFrame(() => focuser?.())
}
