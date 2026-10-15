import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const show = vi.fn()
const hide = vi.fn()
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a), hide: (...a: unknown[]) => hide(...a) },
}))
vi.mock('../../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { Categories } from '@evaos/chat-core/categories'
import { groupChats } from '@evaos/chat-core/chat-groups'
import type { ChatList } from '@evaos/contract'
import { HIGHLIGHT_MS, LIST_LOAD_ERROR, listStore, resetListForTests } from './list-store'

const prefs = {
  chat_categories: [],
  chat_group_order: [],
  chat_assignments: {},
  collapsed_groups: ['eCard'],
}
const row = (i: number) => ({
  id: `g${i}`,
  file: `/s/g${i}.jsonl`,
  title: `Grocery ${i}`,
  mtimeMs: 1000 - i,
  archived: false,
  pinned: false,
  running: false,
  status: null,
})
const value = (n: number): ChatList => ({
  rows: Array.from({ length: n }, (_, i) => row(i)),
  prefs,
  error: null,
})

beforeEach(() => {
  show.mockReset()
  hide.mockReset()
  invoke.mockReset()
  resetListForTests()
})

describe('list-store', () => {
  it('load stores the chat.list value and seeds collapsed from prefs', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: value(2) })
    await listStore.getState().load()
    expect(invoke).toHaveBeenCalledWith('chat.list', {})
    expect(listStore.getState().list?.rows).toHaveLength(2)
    expect([...listStore.getState().collapsed]).toEqual(['eCard'])
    expect(listStore.getState().error).toBeNull()
  })

  it('a failed invoke stores the list load error copy', async () => {
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'boom' } })
    await listStore.getState().load()
    expect(listStore.getState().error).toBe(LIST_LOAD_ERROR)
    expect(LIST_LOAD_ERROR).toBe(
      'Could not read your chats. Check that the sessions folder exists, then reload.',
    )
  })

  it('toggleExpanded flips Other and the derived view shows every row', async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: value(7) })
    await listStore.getState().load()
    const view = () => {
      const s = listStore.getState()
      const v = groupChats(s.list!.rows, Categories.fromPrefs(s.list!.prefs), {
        query: '',
        collapsed: s.collapsed,
        expanded: s.expanded,
      })
      return v.groups.find((g) => g.name === 'Other')!
    }
    expect(view().rows).toHaveLength(5)
    expect(view().hidden).toBe(2)
    listStore.getState().toggleExpanded('Other')
    expect(listStore.getState().expanded.has('Other')).toBe(true)
    expect(view().rows).toHaveLength(7)
    listStore.getState().toggleExpanded('Other')
    expect(listStore.getState().expanded.has('Other')).toBe(false)
  })

  it('toggleCollapsed updates at once and saves the full set', async () => {
    invoke.mockResolvedValue({ ok: true, value: { saved: true } })
    listStore.getState().setList(value(1))
    const p = listStore.getState().toggleCollapsed('Other')
    expect(listStore.getState().collapsed.has('Other')).toBe(true)
    await p
    expect(invoke).toHaveBeenCalledWith('chat.setCollapsed', { groups: ['eCard', 'Other'] })
  })

  it('toggleCollapsed rolls back when the save fails', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'x', message: 'boom' } })
    listStore.getState().setList(value(1))
    await listStore.getState().toggleCollapsed('Other')
    expect(listStore.getState().collapsed.has('Other')).toBe(false)
    expect(listStore.getState().collapsed.has('eCard')).toBe(true)
  })

  it('toggleArchived flips showArchived', () => {
    listStore.getState().toggleArchived()
    expect(listStore.getState().showArchived).toBe(true)
    listStore.getState().toggleArchived()
    expect(listStore.getState().showArchived).toBe(false)
  })

  it('setList keeps local collapse state after the first list', () => {
    invoke.mockResolvedValue({ ok: true, value: { saved: true } })
    listStore.getState().setList(value(1))
    void listStore.getState().toggleCollapsed('eCard')
    listStore.getState().setList({ ...value(1), prefs: { ...prefs, collapsed_groups: ['Other'] } })
    expect(listStore.getState().collapsed.has('eCard')).toBe(false)
  })

  it('setList keeps identity of unchanged rows and marks changed ones for 300 ms', () => {
    vi.useFakeTimers()
    try {
      listStore.getState().setList(value(3))
      const first = listStore.getState().list!.rows
      expect(listStore.getState().changed.size).toBe(0)
      const next = value(3)
      next.rows[1] = { ...next.rows[1]!, status: 'working' }
      listStore.getState().setList(next)
      const rows = listStore.getState().list!.rows
      expect(rows[0]).toBe(first[0])
      expect(rows[2]).toBe(first[2])
      expect(rows[1]).not.toBe(first[1])
      expect([...listStore.getState().changed]).toEqual(['g1'])
      vi.advanceTimersByTime(HIGHLIGHT_MS + 1)
      expect(listStore.getState().changed.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('list-store row actions', () => {
  const seed = async () => {
    invoke.mockResolvedValueOnce({ ok: true, value: value(3) })
    await listStore.getState().load()
    invoke.mockReset()
  }

  it('archive is optimistic, calls chat.archive and shows the toast with Undo', async () => {
    await seed()
    invoke.mockResolvedValue({ ok: true, value: { archived: ['g1'] } })
    const p = listStore.getState().archive('g1', true)
    expect(listStore.getState().list?.rows.find((r) => r.id === 'g1')?.archived).toBe(true)
    await p
    expect(invoke).toHaveBeenCalledWith('chat.archive', { id: 'g1', archived: true })
    expect(show).toHaveBeenCalledTimes(1)
    expect(show.mock.calls[0][0]).toMatchObject({ id: 'chat-archived', autoClose: 6000 })
  })

  it('a failed archive rolls back and shows an error, not the Undo toast', async () => {
    await seed()
    invoke.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'x' } })
    await listStore.getState().archive('g1', true)
    expect(listStore.getState().list?.rows.find((r) => r.id === 'g1')?.archived).toBe(false)
    expect(show.mock.calls[0][0]).toMatchObject({ color: 'red' })
  })

  it('unarchive shows no toast', async () => {
    await seed()
    invoke.mockResolvedValue({ ok: true, value: { archived: [] } })
    await listStore.getState().archive('g1', false)
    expect(show).not.toHaveBeenCalled()
  })

  it('commitRename calls chat.rename with the trimmed name and patches the title', async () => {
    await seed()
    invoke.mockResolvedValue({ ok: true, value: { title: 'Better', via: 'resume' } })
    const r = listStore.getState().list!.rows[1]
    listStore.getState().startRename(r.id)
    await listStore.getState().commitRename(r, '  Better ')
    expect(invoke).toHaveBeenCalledWith('chat.rename', { file: r.file, name: 'Better' })
    expect(listStore.getState().renaming).toBeNull()
    expect(listStore.getState().list?.rows[1].title).toBe('Better')
  })

  it('an empty or unchanged name cancels without a call', async () => {
    await seed()
    const r = listStore.getState().list!.rows[0]
    listStore.getState().startRename(r.id)
    await listStore.getState().commitRename(r, '   ')
    expect(invoke).not.toHaveBeenCalled()
    expect(listStore.getState().renaming).toBeNull()
  })

  it('a rename error is kept for the row', async () => {
    await seed()
    invoke.mockResolvedValue({
      ok: false,
      error: { code: 'maybe-running', message: 'May be open elsewhere.' },
    })
    const r = listStore.getState().list!.rows[0]
    await listStore.getState().commitRename(r, 'Other')
    expect(listStore.getState().rowError).toEqual({ id: r.id, message: 'May be open elsewhere.' })
    expect(listStore.getState().list?.rows[0].title).toBe(r.title)
  })

  it('pin calls chat.pin', async () => {
    await seed()
    invoke.mockResolvedValue({ ok: true, value: { pins: ['g0'] } })
    await listStore.getState().pin('g0', true)
    expect(invoke).toHaveBeenCalledWith('chat.pin', { id: 'g0', pinned: true })
  })
})
