import { beforeEach, describe, expect, it } from 'vitest'
import {
  BOOKMARKS_KEY,
  MAX_BOOKMARKS,
  bookmarksStore,
  reloadBookmarksForTests,
  toggleBookmark,
} from './bookmarks'

beforeEach(() => {
  localStorage.clear()
  reloadBookmarksForTests()
})

describe('bookmarks', () => {
  it('toggles a turn on and off per thread', () => {
    toggleBookmark('assistant:nova', 'user@1')
    toggleBookmark('assistant:nova', 'user@2')
    toggleBookmark('session:s1', 'user@1')
    expect(bookmarksStore.getState().threads).toEqual({
      'assistant:nova': ['user@1', 'user@2'],
      'session:s1': ['user@1'],
    })
    toggleBookmark('assistant:nova', 'user@1')
    expect(bookmarksStore.getState().threads['assistant:nova']).toEqual(['user@2'])
    toggleBookmark('session:s1', 'user@1')
    expect(bookmarksStore.getState().threads['session:s1']).toBeUndefined()
  })

  it('persists across a reload and keeps threads apart', () => {
    toggleBookmark('assistant:astra', 'assistant@9')
    expect(JSON.parse(localStorage.getItem(BOOKMARKS_KEY)!)).toEqual({
      'assistant:astra': ['assistant@9'],
    })
    bookmarksStore.setState({ threads: {} })
    reloadBookmarksForTests()
    expect(bookmarksStore.getState().threads).toEqual({ 'assistant:astra': ['assistant@9'] })
  })

  it('reads garbage in storage as no bookmarks and drops non-string keys', () => {
    localStorage.setItem(BOOKMARKS_KEY, '{not json')
    reloadBookmarksForTests()
    expect(bookmarksStore.getState().threads).toEqual({})
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify({ a: ['k', 3, null], b: 'x', c: [] }))
    reloadBookmarksForTests()
    expect(bookmarksStore.getState().threads).toEqual({ a: ['k'] })
  })

  it('keeps the newest MAX_BOOKMARKS of a thread', () => {
    for (let i = 0; i < MAX_BOOKMARKS + 3; i++) toggleBookmark('t', `k${i}`)
    const keys = bookmarksStore.getState().threads['t']!
    expect(keys).toHaveLength(MAX_BOOKMARKS)
    expect(keys[0]).toBe('k3')
  })
})
