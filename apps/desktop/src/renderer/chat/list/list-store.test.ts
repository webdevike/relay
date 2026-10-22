import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const show = vi.fn()
const hide = vi.fn()
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a), hide: (...a: unknown[]) => hide(...a) },
}))
vi.mock('../../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import type { ChatList } from '@evaos/contract'
import { HIGHLIGHT_MS, LIST_LOAD_ERROR, listStore, resetListForTests } from './list-store'
import { chatRow, listPrefs } from './test-rows'

const prefs = listPrefs({ collapsed_groups: ['eCard'] })
const row = (i: number) => chatRow(`g${i}`, `Grocery ${i}`, { returnedMs: 1000 - i })
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

  it('toggleExpanded flips a folder in memory without saving', () => {
    listStore.getState().toggleExpanded('Other')
    expect(listStore.getState().expanded.has('Other')).toBe(true)
    listStore.getState().toggleExpanded('Other')
    expect(listStore.getState().expanded.has('Other')).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
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

  it('the Snoozed and Settled folds start closed and flip', () => {
    expect(listStore.getState().showSettled).toBe(false)
    listStore.getState().toggleSettled()
    expect(listStore.getState().showSettled).toBe(true)
    listStore.getState().toggleSnoozed()
    expect(listStore.getState().showSnoozed).toBe(true)
    listStore.getState().toggleSnoozed()
    expect(listStore.getState().showSnoozed).toBe(false)
  })

  it('setAgent shows at once, saves, and rolls back on failure', async () => {
    listStore.getState().setList(value(1))
    invoke.mockResolvedValueOnce({ ok: true, value: { saved: true } })
    await listStore.getState().setAgent('Eren')
    expect(invoke).toHaveBeenCalledWith('chat.setAgent', { agent: 'Eren' })
    expect(listStore.getState().list?.prefs.chat_agent).toBe('Eren')
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'no' } })
    await listStore.getState().setAgent('Jobs')
    expect(listStore.getState().list?.prefs.chat_agent).toBe('Eren')
    expect(show.mock.calls[0][0]).toMatchObject({ color: 'red' })
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
      // A changed field that is not shown as a change keeps the row but does not flash.
      next.rows[2] = { ...next.rows[2]!, model: 'claude' }
      listStore.getState().setList(next)
      const rows = listStore.getState().list!.rows
      expect(rows[0]).toBe(first[0])
      expect(rows[2]).not.toBe(first[2])
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

  const rowOf = (id: string) => listStore.getState().list?.rows.find((r) => r.id === id)

  it('settle is optimistic, calls chat.archive and shows the toast with Undo', async () => {
    await seed()
    invoke.mockResolvedValue({ ok: true, value: { archived: ['g1'] } })
    const p = listStore.getState().settle('g1', true)
    expect(rowOf('g1')?.archived).toBe(true)
    await p
    expect(invoke).toHaveBeenCalledWith('chat.archive', { id: 'g1', archived: true })
    expect(show).toHaveBeenCalledTimes(1)
    expect(show.mock.calls[0][0]).toMatchObject({ id: 'chat-settled', autoClose: 6000 })
  })

  it('a failed settle rolls back and shows an error, not the Undo toast', async () => {
    await seed()
    invoke.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'x' } })
    await listStore.getState().settle('g1', true)
    expect(rowOf('g1')?.archived).toBe(false)
    expect(show.mock.calls[0][0]).toMatchObject({ color: 'red' })
  })

  it('unsettle keeps the chat listed from now and shows no toast', async () => {
    await seed()
    invoke.mockResolvedValue({ ok: true, value: { archived: [] } })
    const before = Date.now()
    await listStore.getState().settle('g1', false)
    expect(rowOf('g1')?.keptMs).toBeGreaterThanOrEqual(before)
    expect(show).not.toHaveBeenCalled()
  })

  it('snooze patches the row, calls chat.snooze, and rolls back on failure', async () => {
    await seed()
    invoke.mockResolvedValue({ ok: true, value: { saved: true } })
    await listStore.getState().snooze('g1', 5000)
    expect(invoke).toHaveBeenCalledWith('chat.snooze', { id: 'g1', untilMs: 5000 })
    expect(rowOf('g1')?.snoozedUntilMs).toBe(5000)
    invoke.mockResolvedValue({ ok: false, error: { code: 'x', message: 'no' } })
    await listStore.getState().snooze('g1', null)
    expect(rowOf('g1')?.snoozedUntilMs).toBe(5000)
  })

  it('markRead reads the chat and clears woke', async () => {
    await seed()
    invoke.mockResolvedValue({ ok: true, value: { saved: true } })
    listStore.getState().setList({
      ...value(3),
      rows: value(3).rows.map((r) => ({ ...r, openedMs: null, wokeMs: 1 })),
    })
    await listStore.getState().markRead('g0')
    expect(invoke).toHaveBeenCalledWith('chat.markRead', { id: 'g0' })
    expect(rowOf('g0')?.openedMs).not.toBeNull()
    expect(rowOf('g0')?.wokeMs).toBeNull()
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

describe('category ops', () => {
  const seed = async (): Promise<void> => {
    invoke.mockResolvedValueOnce({ ok: true, value: value(3) })
    await listStore.getState().load()
    invoke.mockReset()
    invoke.mockResolvedValue({ ok: true, value: { saved: true } })
  }

  it('createCategory persists the three keys with the new name first', async () => {
    await seed()
    expect(await listStore.getState().createCategory('Focus')).toBeNull()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('chat.setCategories', {
      chat_categories: ['Focus'],
      chat_group_order: ['Focus'],
      chat_assignments: {},
    })
    expect(listStore.getState().list?.prefs.chat_categories).toEqual(['Focus'])
  })

  it('an empty or duplicate name returns the Rust error and calls nothing', async () => {
    await seed()
    expect(await listStore.getState().createCategory(' ')).toBe('Give the category a name.')
    await listStore.getState().createCategory('Focus')
    invoke.mockClear()
    expect(await listStore.getState().createCategory('focus')).toBe(
      'A category with that name already exists.',
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('moveChat assigns and null clears; deleteCategory frees its chats', async () => {
    await seed()
    await listStore.getState().createCategory('Focus')
    await listStore.getState().moveChat('g1', 'Focus')
    expect(listStore.getState().list?.prefs.chat_assignments).toEqual({ g1: 'Focus' })
    await listStore.getState().deleteCategory('Focus')
    expect(listStore.getState().list?.prefs).toMatchObject({
      chat_categories: [],
      chat_group_order: [],
      chat_assignments: {},
    })
    await listStore.getState().moveChat('g1', 'Relay')
    await listStore.getState().moveChat('g1', null)
    expect(listStore.getState().list?.prefs.chat_assignments).toEqual({})
  })

  it('renameCategory carries the assignments along', async () => {
    await seed()
    await listStore.getState().createCategory('Focus')
    await listStore.getState().moveChat('g1', 'Focus')
    expect(await listStore.getState().renameCategory('Focus', 'Deep work')).toBeNull()
    expect(listStore.getState().list?.prefs).toMatchObject({
      chat_categories: ['Deep work'],
      chat_assignments: { g1: 'Deep work' },
    })
    expect(await listStore.getState().renameCategory('Relay', 'X')).toBe(
      'Only your own categories can be renamed.',
    )
  })

  it('a failed save rolls the prefs back', async () => {
    await seed()
    invoke.mockResolvedValue({ ok: false, error: { code: 'x', message: 'no' } })
    expect(await listStore.getState().createCategory('Focus')).toBe(
      'Could not save your categories. Try again.',
    )
    expect(listStore.getState().list?.prefs.chat_categories).toEqual([])
    expect(show).toHaveBeenCalled()
  })
})
