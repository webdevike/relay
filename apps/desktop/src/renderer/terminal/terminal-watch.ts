import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

/** A herdr pane the Working tab asked the Terminal tool to show view-only (a harness). */
export interface WatchRequest {
  pane: string
  title: string
  /** Distinguishes two asks for the same pane. */
  seq: number
}

let seq = 0
export const watchStore = createStore<{ request: WatchRequest | null }>(() => ({ request: null }))

/** Asks the Terminal tool to open `pane` view-only; the panel takes the request when it shows. */
export function requestWatch(pane: string, title: string): void {
  watchStore.setState({ request: { pane, title, seq: ++seq } })
}

/** The pending request; the panel clears it once a tab is open for it. */
export function useWatchRequest(): WatchRequest | null {
  return useStore(watchStore, (s) => s.request)
}

export function takeWatchRequest(): void {
  watchStore.setState({ request: null })
}
