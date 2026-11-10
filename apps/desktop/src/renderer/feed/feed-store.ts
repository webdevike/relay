import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { FeedAction, FeedItemDto } from '@evaos/contract'
import { invoke } from '../ipc'

export interface FeedSource {
  ok: boolean
  count?: number
  error?: string
  disabled?: boolean
}

export interface FeedState {
  items: FeedItemDto[] | null
  sources: Record<string, FeedSource>
  generatedAt: string | null
  acted: Record<string, FeedAction>
  error: boolean
  refreshing: boolean
}

const initial = (): FeedState => ({
  items: null,
  sources: {},
  generatedAt: null,
  acted: {},
  error: false,
  refreshing: false,
})

export const feedStore = createStore<FeedState>(initial)

export function useFeed<T>(selector: (s: FeedState) => T): T {
  return useStore(feedStore, selector)
}

export async function loadFeed(): Promise<void> {
  try {
    const r = await invoke('feed.list', {})
    if (r.ok) {
      const { items, sources, generatedAt, acted } = r.value
      feedStore.setState({ items, sources, generatedAt, acted, error: false })
    } else feedStore.setState({ error: true })
  } catch {
    feedStore.setState({ error: true })
  }
}

/** Optimistic; the signal is appended to work/discovery-feed/signals.jsonl and the next fetch ranks with it. */
export function signalItem(item: FeedItemDto, action: FeedAction): void {
  const { acted } = feedStore.getState()
  feedStore.setState({
    acted: { ...acted, [item.id]: acted[item.id] === action ? acted[item.id] : action },
  })
  void invoke('feed.signal', { id: item.id, action, title: item.title, source: item.source })
}

export async function refreshFeed(): Promise<void> {
  feedStore.setState({ refreshing: true })
  try {
    await invoke('feed.refresh', {})
    // The fetch takes about 30 s; look for its output a few times.
    for (const wait of [15000, 15000, 20000]) {
      await new Promise((r) => setTimeout(r, wait))
      await loadFeed()
    }
  } finally {
    feedStore.setState({ refreshing: false })
  }
}
