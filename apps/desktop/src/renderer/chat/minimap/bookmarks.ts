import { useMemo } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

/**
 * Turn bookmarks per thread (an assistant's thread, a chat's session, else its file), kept in this
 * window's localStorage: desktop-local for now. Each is a turn key (Turn.key), which outlives
 * reloads because it is the bubble's timestamp key, not a row id.
 */
export const BOOKMARKS_KEY = 'relay.chat-bookmarks.v1'

/** Most bookmarks kept per thread; the oldest go first. */
export const MAX_BOOKMARKS = 500

interface BookmarksState {
  threads: Record<string, string[]>
}

function read(): Record<string, string[]> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? '{}')
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const out: Record<string, string[]> = {}
    for (const [thread, keys] of Object.entries(raw)) {
      if (!Array.isArray(keys)) continue
      const ok = keys.filter((k): k is string => typeof k === 'string')
      if (ok.length > 0) out[thread] = ok.slice(-MAX_BOOKMARKS)
    }
    return out
  } catch {
    return {}
  }
}

export const bookmarksStore = createStore<BookmarksState>(() => ({ threads: read() }))

function save(threads: Record<string, string[]>): void {
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(threads))
  } catch {
    // Storage off: bookmarks last until the window closes.
  }
}

/** Marks or unmarks turn `key` in `thread`. */
export function toggleBookmark(thread: string, key: string): void {
  const { threads } = bookmarksStore.getState()
  const have = threads[thread] ?? []
  const keys = have.includes(key)
    ? have.filter((k) => k !== key)
    : [...have, key].slice(-MAX_BOOKMARKS)
  const { [thread]: _old, ...rest } = threads
  const next = keys.length === 0 ? rest : { ...rest, [thread]: keys }
  bookmarksStore.setState({ threads: next })
  save(next)
}

const NONE: readonly string[] = []

/** The bookmarked turn keys of `thread`, live. */
export function useBookmarks(thread: string): ReadonlySet<string> {
  const keys = useStore(bookmarksStore, (s) => s.threads[thread] ?? NONE)
  return useMemo(() => new Set(keys), [keys])
}

/** Test seam: forget memory and reload what is in storage. */
export function reloadBookmarksForTests(): void {
  bookmarksStore.setState({ threads: read() })
}
