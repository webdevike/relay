import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { Categories } from '@evaos/chat-core/categories'
import { groupChats } from '@evaos/chat-core/chat-groups'
import type { ChatList } from '@evaos/contract'
import { LIST_LOAD_ERROR, listStore, resetListForTests } from './list-store'

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
})
