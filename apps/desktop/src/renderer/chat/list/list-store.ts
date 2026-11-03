import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { Categories } from '@evaos/chat-core/categories'
import type { ChatAgent, ChatList, ChatRow } from '@evaos/contract'
import { notifications } from '@mantine/notifications'
import { invoke, on } from '../../ipc'
import { showSettledToast } from './settle-toast'

export const LIST_LOAD_ERROR =
  'Could not read your chats. Check that the sessions folder exists, then reload.'

export interface ListState {
  list: ChatList | null
  /** Row ids whose title, status or mtime just changed; cleared after HIGHLIGHT_MS. */
  changed: Set<string>
  error: string | null
  /** Folders showing every chat instead of ten (`Show N more`); in memory only, as native. */
  expanded: Set<string>
  /** Collapsed groups; seeded from chat.json on the first list, toggled locally after. */
  collapsed: Set<string>
  load(): Promise<void>
  setList(l: ChatList): void
  toggleExpanded(group: string): void
  /** The `Snoozed (n)` and `Settled (n)` folds at the bottom; closed by default. */
  showSnoozed: boolean
  showSettled: boolean
  toggleCollapsed(group: string): Promise<void>
  toggleSnoozed(): void
  toggleSettled(): void
  /** Lists only this agent's chats; saved in chat.json `chat_agent`. */
  setAgent(agent: ChatAgent): Promise<void>
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
  /** Settle (archive) or Unsettle; unsettling also keeps it listed from now (native `kept`). */
  settle(id: string, settled: boolean): Promise<void>
  /** Snooze until a time, or Unsnooze with null. */
  snooze(id: string, untilMs: number | null): Promise<void>
  /** The chat was shown: read since it returned, and no longer woke. */
  markRead(id: string): Promise<void>
  /** Category edits: each returns the Rust error string when the op is rejected, else null. */
  createCategory(name: string): Promise<string | null>
  renameCategory(from: string, to: string): Promise<string | null>
  deleteCategory(name: string): Promise<string | null>
  moveChat(id: string, group: string | null): Promise<string | null>
  /** The delete-category dialog and the category being renamed inline. */
  deletingCategory: string | null
  renamingCategory: string | null
  setDeletingCategory(name: string | null): void
  setRenamingCategory(name: string | null): void
}

export const CATEGORY_FAILED = 'Could not save your categories. Try again.'

export const SETTLE_FAILED = 'Could not settle this chat. Try again.'
export const UNSETTLE_FAILED = 'Could not unsettle this chat. Try again.'
export const PIN_FAILED = 'Could not change the pin. Try again.'
export const SNOOZE_FAILED = 'Could not change the snooze. Try again.'
export const AGENT_FAILED = 'Could not save the agent. Try again.'

export const HIGHLIGHT_MS = 300

const sameWork = (a: ChatRow['work'], b: ChatRow['work']): boolean =>
  a === b || (a !== null && b !== null && a.key === b.key && a.branch === b.branch && a.pr === b.pr)

/** Every field equal; `work` by value. */
const sameRow = (a: ChatRow, b: ChatRow): boolean =>
  (Object.keys(a) as (keyof ChatRow)[]).every((k) =>
    k === 'work' ? sameWork(a.work, b.work) : a[k] === b[k],
  )

/** What the highlight flash marks: a new title, status or return. */
const flashes = (a: ChatRow, b: ChatRow): boolean =>
  a.title !== b.title || a.status !== b.status || a.returnedMs !== b.returnedMs

const failed = (message: string): void => {
  notifications.show({ color: 'red', message, autoClose: 6000 })
}

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
  showSnoozed: false,
  showSettled: false,
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
      if (prev !== null && (!old || flashes(old, r))) changed.add(r.id)
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
  toggleSnoozed: () => set((s) => ({ showSnoozed: !s.showSnoozed })),
  toggleSettled: () => set((s) => ({ showSettled: !s.showSettled })),
  async setAgent(agent) {
    const list = get().list
    if (!list || list.prefs.chat_agent === agent) return
    const before = list.prefs
    const next = { ...before, chat_agent: agent }
    set({ list: { ...list, prefs: next } })
    const r = await invoke('chat.setAgent', { agent })
    if (!r.ok) {
      const cur = get().list
      if (cur && cur.prefs === next) set({ list: { ...cur, prefs: before } })
      failed(AGENT_FAILED)
    }
  },
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
    if (!r.ok) failed(PIN_FAILED)
  },
  async settle(id, settled) {
    const row = get().list?.rows.find((r) => r.id === id)
    if (!row) return
    patchRow(set, get, id, settled ? { archived: true } : { archived: false, keptMs: Date.now() })
    const r = await invoke('chat.archive', { id, archived: settled })
    if (!r.ok) {
      patchRow(set, get, id, { archived: row.archived, keptMs: row.keptMs })
      failed(settled ? SETTLE_FAILED : UNSETTLE_FAILED)
      return
    }
    if (settled) showSettledToast(() => void get().settle(id, false))
  },
  async snooze(id, untilMs) {
    const row = get().list?.rows.find((r) => r.id === id)
    if (!row) return
    patchRow(set, get, id, { snoozedUntilMs: untilMs })
    const r = await invoke('chat.snooze', { id, untilMs })
    if (!r.ok) {
      patchRow(set, get, id, { snoozedUntilMs: row.snoozedUntilMs })
      failed(SNOOZE_FAILED)
    }
  },
  async markRead(id) {
    patchRow(set, get, id, { openedMs: Date.now(), wokeMs: null })
    // A failed save only leaves the chat unread until the next list push.
    await invoke('chat.markRead', { id })
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
}))

type Edit = (c: Categories) => { ok: true } | { ok: false; error: string }

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
  const res = edit(cats)
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
    showSnoozed: false,
    showSettled: false,
    menu: null,
    renaming: null,
    renamePending: false,
    rowError: null,
    deleting: null,
    deletingCategory: null,
    renamingCategory: null,
  })
}
