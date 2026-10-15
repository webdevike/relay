import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ChatList } from '@evaos/contract'
import { invoke } from '../../ipc'

export const LIST_LOAD_ERROR =
  'Could not read your chats. Check that the sessions folder exists, then reload.'

export interface ListState {
  list: ChatList | null
  error: string | null
  /** Groups showing every chat instead of five (`Show N more`). */
  expanded: Set<string>
  /** Collapsed groups; seeded from chat.json on the first list, toggled locally after. */
  collapsed: Set<string>
  load(): Promise<void>
  setList(l: ChatList): void
  toggleExpanded(group: string): void
  /** The `Archived (n)` section at the bottom of the list, when not searching. */
  showArchived: boolean
  toggleCollapsed(group: string): Promise<void>
  toggleArchived(): void
}

const flip = (set: Set<string>, name: string): Set<string> => {
  const next = new Set(set)
  if (!next.delete(name)) next.add(name)
  return next
}

export const listStore = createStore<ListState>((set, get) => ({
  list: null,
  error: null,
  expanded: new Set(),
  collapsed: new Set(),
  showArchived: false,
  async load() {
    const r = await invoke('chat.list', {})
    // The contract already validated the value in main; this guards a failed invoke only.
    if (!r.ok || !Array.isArray(r.value.rows)) {
      set({ error: LIST_LOAD_ERROR })
      return
    }
    get().setList(r.value)
  },
  setList(l) {
    set((s) => ({
      list: l,
      error: l.error,
      collapsed: s.list === null ? new Set(l.prefs.collapsed_groups) : s.collapsed,
    }))
  },
  toggleExpanded: (group) => set((s) => ({ expanded: flip(s.expanded, group) })),
  async toggleCollapsed(group) {
    const before = get().collapsed
    const next = flip(before, group)
    set({ collapsed: next })
    const r = await invoke('chat.setCollapsed', { groups: [...next] })
    // Roll back only if nothing else changed the set meanwhile.
    if (!r.ok && get().collapsed === next) set({ collapsed: before })
  },
  toggleArchived: () => set((s) => ({ showArchived: !s.showArchived })),
}))

export function useListStore<T>(selector: (s: ListState) => T): T {
  return useStore(listStore, selector)
}

export function resetListForTests(): void {
  listStore.setState({
    list: null,
    error: null,
    expanded: new Set(),
    collapsed: new Set(),
    showArchived: false,
  })
}
