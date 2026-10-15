import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { Categories } from '@evaos/chat-core/categories'
import { groupChats } from '@evaos/chat-core/chat-groups'
import type { ChatList, ChatRow } from '@evaos/contract'
import { notifications } from '@mantine/notifications'
import { invoke, on } from '../../ipc'
import { showArchivedToast } from './archive-toast'

export const LIST_LOAD_ERROR =
  'Could not read your chats. Check that the sessions folder exists, then reload.'

export interface ListState {
  list: ChatList | null
  /** Row ids whose title, status or mtime just changed; cleared after HIGHLIGHT_MS. */
  changed: Set<string>
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
  /** Row menu: one instance for the whole list, anchored at a viewport point. */
  menu: { id: string; x: number; y: number } | null
  /** The chat being renamed inline, and whether its commit is in flight. */
  renaming: string | null
  renamePending: boolean
  /** Message shown under a row after a failed action. */
  rowError: { id: string; message: string } | null
  /** The chat the delete dialog is open for. */
  deleting: ChatRow | null
  openMenu(id: string, x: number, y: number): void
  closeMenu(): void
  startRename(id: string): void
  cancelRename(): void
  commitRename(row: ChatRow, name: string): Promise<void>
  setDeleting(row: ChatRow | null): void
  pin(id: string, pinned: boolean): Promise<void>
  archive(id: string, archived: boolean): Promise<void>
  /** Category edits: each returns the Rust error string when the op is rejected, else null. */
  createCategory(name: string): Promise<string | null>
  renameCategory(from: string, to: string): Promise<string | null>
  deleteCategory(name: string): Promise<string | null>
  moveChat(id: string, group: string | null): Promise<string | null>
  reorderGroups(moving: string, target: string): Promise<string | null>
  /** The delete-category dialog and the category being renamed inline. */
  deletingCategory: string | null
  renamingCategory: string | null
  setDeletingCategory(name: string | null): void
  setRenamingCategory(name: string | null): void
}

export const CATEGORY_FAILED = 'Could not save your categories. Try again.'

export const ARCHIVE_FAILED = 'Could not archive this chat. Try again.'
export const PIN_FAILED = 'Could not change the pin. Try again.'

export const HIGHLIGHT_MS = 300

const sameRow = (a: ChatRow, b: ChatRow): boolean =>
  a.file === b.file &&
  a.title === b.title &&
  a.status === b.status &&
  a.mtimeMs === b.mtimeMs &&
  a.archived === b.archived &&
  a.pinned === b.pinned &&
  a.running === b.running

let highlightTimer: ReturnType<typeof setTimeout> | null = null

const flip = (set: Set<string>, name: string): Set<string> => {
  const next = new Set(set)
  if (!next.delete(name)) next.add(name)
  return next
}

export const listStore = createStore<ListState>((set, get) => ({
  list: null,
  changed: new Set(),
  error: null,
  expanded: new Set(),
  collapsed: new Set(),
  showArchived: false,
  menu: null,
  renaming: null,
  renamePending: false,
  rowError: null,
  deleting: null,
  deletingCategory: null,
  renamingCategory: null,
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
    const prev = get().list
    const before = new Map(prev?.rows.map((r) => [r.id, r]))
    const changed = new Set<string>()
    // Unchanged rows keep their object identity so memoised rows do not re-render.
    const rows = l.rows.map((r) => {
      const old = before.get(r.id)
      if (old && sameRow(old, r)) return old
      if (prev !== null) changed.add(r.id)
      return r
    })
    set((s) => ({
      list: { ...l, rows },
      changed,
      error: l.error,
      collapsed: s.list === null ? new Set(l.prefs.collapsed_groups) : s.collapsed,
    }))
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = null
    if (changed.size > 0) {
      highlightTimer = setTimeout(() => {
        highlightTimer = null
        set({ changed: new Set() })
      }, HIGHLIGHT_MS)
    }
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
  openMenu: (id, x, y) => set({ menu: { id, x, y }, rowError: null }),
  closeMenu: () => set({ menu: null }),
  startRename: (id) => set({ renaming: id, renamePending: false, rowError: null, menu: null }),
  cancelRename: () => set({ renaming: null, renamePending: false }),
  async commitRename(row, name) {
    const next = name.trim()
    if (next === '' || next === row.title) {
      get().cancelRename()
      return
    }
    set({ renamePending: true })
    const r = await invoke('chat.rename', { file: row.file, name: next })
    set({ renaming: null, renamePending: false })
    if (r.ok) {
      patchRow(set, get, row.id, { title: r.value.title })
    } else {
      set({ rowError: { id: row.id, message: r.error.message } })
    }
  },
  setDeleting: (row) => set({ deleting: row, menu: null }),
  async pin(id, pinned) {
    const r = await invoke('chat.pin', { id, pinned })
    if (!r.ok) notifications.show({ color: 'red', message: PIN_FAILED, autoClose: 6000 })
  },
  async archive(id, archived) {
    patchRow(set, get, id, { archived })
    const r = await invoke('chat.archive', { id, archived })
    if (!r.ok) {
      patchRow(set, get, id, { archived: !archived })
      notifications.show({ color: 'red', message: ARCHIVE_FAILED, autoClose: 6000 })
      return
    }
    if (archived) showArchivedToast(() => void get().archive(id, false))
  },
  setDeletingCategory: (name) => set({ deletingCategory: name, menu: null }),
  setRenamingCategory: (name) => set({ renamingCategory: name }),
  createCategory: (name) => editCategories(set, get, (c) => c.add(name)),
  renameCategory: (from, to) => editCategories(set, get, (c) => c.rename(from, to)),
  deleteCategory: (name) =>
    editCategories(set, get, (c) => {
      c.remove(name)
      return { ok: true }
    }),
  moveChat: (id, group) =>
    editCategories(set, get, (c) => {
      c.assign(id, group)
      return { ok: true }
    }),
  reorderGroups: (moving, target) =>
    editCategories(set, get, (c, l) => {
      const shown = groupChats(l.rows, c, {
        query: '',
        collapsed: new Set(),
        expanded: new Set(),
      }).groups.map((g) => g.name)
      c.reorder(shown, moving, target)
      return { ok: true }
    }),
}))

type Edit = (c: Categories, list: ChatList) => { ok: true } | { ok: false; error: string }

/**
 * Applies one Categories op to a copy of the prefs, shows it at once, then saves the three keys in
 * one write. A rejected op changes nothing; a failed save rolls back.
 */
async function editCategories(
  set: (partial: Partial<ListState>) => void,
  get: () => ListState,
  edit: Edit,
): Promise<string | null> {
  const list = get().list
  if (!list) return null
  const cats = Categories.fromPrefs(list.prefs)
  const res = edit(cats, list)
  if (!res.ok) return res.error
  const next = { ...list.prefs, ...cats.toPrefs() }
  set({ list: { ...list, prefs: next } })
  const r = await invoke('chat.setCategories', cats.toPrefs())
  if (!r.ok) {
    const cur = get().list
    if (cur && cur.prefs === next) set({ list: { ...cur, prefs: list.prefs } })
    notifications.show({ color: 'red', message: CATEGORY_FAILED, autoClose: 6000 })
    return CATEGORY_FAILED
  }
  return null
}

/** Replaces fields of one row in place (a later pushed list wins). */
function patchRow(
  set: (partial: Partial<ListState>) => void,
  get: () => ListState,
  id: string,
  patch: Partial<ChatRow>,
): void {
  const list = get().list
  if (!list) return
  set({ list: { ...list, rows: list.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) } })
}

/** One subscription to main's list pushes; returns the unsubscribe. */
export function subscribeListChanges(): () => void {
  return on('chat.listChanged', (l) => listStore.getState().setList(l))
}

export function useListStore<T>(selector: (s: ListState) => T): T {
  return useStore(listStore, selector)
}

export function resetListForTests(): void {
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightTimer = null
  listStore.setState({
    list: null,
    changed: new Set(),
    error: null,
    expanded: new Set(),
    collapsed: new Set(),
    showArchived: false,
    menu: null,
    renaming: null,
    renamePending: false,
    rowError: null,
    deleting: null,
    deletingCategory: null,
    renamingCategory: null,
  })
}
