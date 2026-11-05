import { useMemo } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { ReactionKeySchema } from '@evaos/chat-core/reactions'
import { invoke } from '../../ipc'

/**
 * Turn bookmarks per thread (an assistant's thread, a chat's session, else its file). Each is a turn
 * key (Turn.key): the bubble's reaction key, the same on every device.
 *
 * With a Relay Host that keeps bookmarks (`welcome.features` "bookmarks") the host owns them: its
 * snapshots arrive with the thread's reactions (`applyHostBookmarks`), a toggle shows at once and is
 * sent up, and the phone sees the same set. Without one (an older host, Relay down) they live in this
 * window's localStorage. The first host snapshot of a thread carries whatever local bookmarks it
 * had up to the host, once, and forgets them here.
 */
export const BOOKMARKS_KEY = 'relay.chat-bookmarks.v1'

/** Most bookmarks kept per thread; the oldest go first. */
export const MAX_BOOKMARKS = 500

interface BookmarksState {
  /** On this device: threads without a host that keeps bookmarks. */
  local: Record<string, string[]>
  /** The host's bookmarks of each thread it has answered for. */
  host: Record<string, string[]>
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

export const bookmarksStore = createStore<BookmarksState>(() => ({ local: read(), host: {} }))

function saveLocal(local: Record<string, string[]>): void {
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(local))
  } catch {
    // Storage off: bookmarks last until the window closes.
  }
}

function without(map: Record<string, string[]>, thread: string): Record<string, string[]> {
  const { [thread]: _gone, ...rest } = map
  return rest
}

/** `keys` with `key` marked or unmarked, the oldest dropped past MAX_BOOKMARKS. */
function toggled(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key].slice(-MAX_BOOKMARKS)
}

/**
 * The host's bookmarks of `thread` (null: it keeps none, so they stay on this device). Local ones
 * the host does not have yet go up now, once.
 */
export function applyHostBookmarks(thread: string, keys: readonly string[] | null): void {
  const { local, host } = bookmarksStore.getState()
  if (keys === null) {
    if (host[thread] !== undefined) bookmarksStore.setState({ host: without(host, thread) })
    return
  }
  const mine = local[thread] ?? []
  const missing = mine.filter((k) => !keys.includes(k) && ReactionKeySchema.safeParse(k).success)
  const nextLocal = mine.length > 0 ? without(local, thread) : local
  bookmarksStore.setState({ host: { ...host, [thread]: [...keys] }, local: nextLocal })
  if (mine.length > 0) saveLocal(nextLocal)
  for (const message of missing) void invoke('reactions.bookmark', { thread, message, on: true })
}

/** Whether turn `key` of `thread` can be bookmarked now: any turn on this device, only a bubble with a reaction key on the host. */
export function canBookmark(thread: string, key: string): boolean {
  return (
    bookmarksStore.getState().host[thread] === undefined || ReactionKeySchema.safeParse(key).success
  )
}

/** Marks or unmarks turn `key` in `thread`: on the host when it keeps them, else on this device. */
export function toggleBookmark(thread: string, key: string): void {
  const { local, host } = bookmarksStore.getState()
  const onHost = host[thread]
  if (onHost !== undefined) {
    if (!ReactionKeySchema.safeParse(key).success) return
    const on = !onHost.includes(key)
    const next = toggled(onHost, key)
    bookmarksStore.setState((s) => ({ host: { ...s.host, [thread]: next } }))
    void invoke('reactions.bookmark', { thread, message: key, on }).then((r) => {
      if (r.ok && r.value.sent) return
      // Not sent: undo, unless a snapshot already replaced the guess.
      if (bookmarksStore.getState().host[thread] === next) {
        bookmarksStore.setState((s) => ({ host: { ...s.host, [thread]: onHost } }))
      }
    })
    return
  }
  const keys = toggled(local[thread] ?? [], key)
  const nextLocal = keys.length === 0 ? without(local, thread) : { ...local, [thread]: keys }
  bookmarksStore.setState({ local: nextLocal })
  saveLocal(nextLocal)
}

const NONE: readonly string[] = []

/** The bookmarked turn keys of `thread`, live. */
export function useBookmarks(thread: string): ReadonlySet<string> {
  const keys = useStore(bookmarksStore, (s) => s.host[thread] ?? s.local[thread] ?? NONE)
  return useMemo(() => new Set(keys), [keys])
}

/** Test seam: forget memory and reload what is in storage. */
export function reloadBookmarksForTests(): void {
  bookmarksStore.setState({ local: read(), host: {} })
}
