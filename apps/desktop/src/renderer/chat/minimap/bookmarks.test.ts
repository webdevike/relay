import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../../ipc', () => ({ invoke, on: () => () => {} }))

import {
  BOOKMARKS_KEY,
  MAX_BOOKMARKS,
  applyHostBookmarks,
  bookmarksStore,
  canBookmark,
  reloadBookmarksForTests,
  toggleBookmark,
} from './bookmarks'

const sentUp = { ok: true, value: { sent: true } }

beforeEach(() => {
  localStorage.clear()
  invoke.mockReset()
  invoke.mockResolvedValue(sentUp)
  reloadBookmarksForTests()
})

describe('bookmarks on this device (no host that keeps them)', () => {
  it('toggles a turn on and off per thread', () => {
    toggleBookmark('assistant:nova', 'user@1')
    toggleBookmark('assistant:nova', 'user@2')
    toggleBookmark('session:s1', 'user@1')
    expect(bookmarksStore.getState().local).toEqual({
      'assistant:nova': ['user@1', 'user@2'],
      'session:s1': ['user@1'],
    })
    toggleBookmark('assistant:nova', 'user@1')
    expect(bookmarksStore.getState().local['assistant:nova']).toEqual(['user@2'])
    toggleBookmark('session:s1', 'user@1')
    expect(bookmarksStore.getState().local['session:s1']).toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('persists across a reload and keeps threads apart', () => {
    toggleBookmark('assistant:astra', 'assistant@9')
    expect(JSON.parse(localStorage.getItem(BOOKMARKS_KEY)!)).toEqual({
      'assistant:astra': ['assistant@9'],
    })
    bookmarksStore.setState({ local: {} })
    reloadBookmarksForTests()
    expect(bookmarksStore.getState().local).toEqual({ 'assistant:astra': ['assistant@9'] })
  })

  it('reads garbage in storage as no bookmarks and drops non-string keys', () => {
    localStorage.setItem(BOOKMARKS_KEY, '{not json')
    reloadBookmarksForTests()
    expect(bookmarksStore.getState().local).toEqual({})
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify({ a: ['k', 3, null], b: 'x', c: [] }))
    reloadBookmarksForTests()
    expect(bookmarksStore.getState().local).toEqual({ a: ['k'] })
  })

  it('keeps the newest MAX_BOOKMARKS of a thread', () => {
    for (let i = 0; i < MAX_BOOKMARKS + 3; i++) toggleBookmark('t', `k${i}`)
    const keys = bookmarksStore.getState().local['t']!
    expect(keys).toHaveLength(MAX_BOOKMARKS)
    expect(keys[0]).toBe('k3')
  })

  it('can bookmark any turn, a file-keyed one included', () => {
    expect(canBookmark('file:/s/a.jsonl', 'u1')).toBe(true)
  })
})

describe('bookmarks on the host', () => {
  it("shows the host's set and sends a toggle up, at once", () => {
    applyHostBookmarks('session:s1', ['user@1'])
    toggleBookmark('session:s1', 'user@2')
    expect(bookmarksStore.getState().host['session:s1']).toEqual(['user@1', 'user@2'])
    expect(invoke).toHaveBeenLastCalledWith('reactions.bookmark', {
      thread: 'session:s1',
      message: 'user@2',
      on: true,
    })
    toggleBookmark('session:s1', 'user@1')
    expect(bookmarksStore.getState().host['session:s1']).toEqual(['user@2'])
    expect(invoke).toHaveBeenLastCalledWith('reactions.bookmark', {
      thread: 'session:s1',
      message: 'user@1',
      on: false,
    })
    // Nothing went to this device's storage.
    expect(localStorage.getItem(BOOKMARKS_KEY)).toBeNull()
  })

  it('takes a toggle back when it could not be sent, unless a snapshot already replaced it', async () => {
    applyHostBookmarks('session:s1', ['user@1'])
    invoke.mockResolvedValueOnce({ ok: true, value: { sent: false } })
    toggleBookmark('session:s1', 'user@2')
    await Promise.resolve()
    await Promise.resolve()
    expect(bookmarksStore.getState().host['session:s1']).toEqual(['user@1'])
    invoke.mockResolvedValueOnce({ ok: true, value: { sent: false } })
    toggleBookmark('session:s1', 'user@3')
    applyHostBookmarks('session:s1', ['user@1', 'user@9'])
    await Promise.resolve()
    await Promise.resolve()
    expect(bookmarksStore.getState().host['session:s1']).toEqual(['user@1', 'user@9'])
  })

  it('refuses a turn the host cannot name', () => {
    applyHostBookmarks('session:s1', [])
    expect(canBookmark('session:s1', 'row-3')).toBe(false)
    toggleBookmark('session:s1', 'row-3')
    expect(invoke).not.toHaveBeenCalled()
    expect(canBookmark('session:s1', 'user@3')).toBe(true)
  })

  it("sends this device's bookmarks up once with the first snapshot, then forgets them", () => {
    toggleBookmark('session:s1', 'user@1')
    toggleBookmark('session:s1', 'user@2')
    toggleBookmark('session:s1', 'row-3')
    toggleBookmark('session:s2', 'user@5')
    applyHostBookmarks('session:s1', ['user@1', 'assistant@8'])
    // user@1 is the host's already, row-3 is no turn the host can name.
    expect(invoke.mock.calls).toEqual([
      ['reactions.bookmark', { thread: 'session:s1', message: 'user@2', on: true }],
    ])
    expect(bookmarksStore.getState().host['session:s1']).toEqual(['user@1', 'assistant@8'])
    expect(bookmarksStore.getState().local).toEqual({ 'session:s2': ['user@5'] })
    expect(JSON.parse(localStorage.getItem(BOOKMARKS_KEY)!)).toEqual({ 'session:s2': ['user@5'] })
    applyHostBookmarks('session:s1', ['user@1', 'assistant@8', 'user@2'])
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('falls back to this device when the host stops keeping them', () => {
    applyHostBookmarks('session:s1', ['user@1'])
    applyHostBookmarks('session:s1', null)
    expect(bookmarksStore.getState().host).toEqual({})
    toggleBookmark('session:s1', 'user@2')
    expect(bookmarksStore.getState().local).toEqual({ 'session:s1': ['user@2'] })
  })
})
