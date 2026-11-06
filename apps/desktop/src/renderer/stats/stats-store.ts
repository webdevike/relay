import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { StatsView } from '@evaos/contract'
import { invoke, on } from '../ipc'

/** The host's last stats snapshot as main relays it; null until the first answer. */
export const statsStore = createStore<{ view: StatsView | null }>(() => ({ view: null }))

export function useStats<T>(selector: (view: StatsView | null) => T): T {
  return useStore(statsStore, (s) => selector(s.view))
}

function load(): void {
  void invoke('stats.get', {}).then((r) => {
    statsStore.setState({
      view: r.ok ? r.value : { stats: null, unavailable: `Couldn't get usage: ${r.error.message}` },
    })
  })
}

/** Mirrors the host's snapshots while the Usage page is open; asks again when the host comes up. */
export function startStats(): () => void {
  const off = on('stats.changed', (view) => {
    if (view.stats === null && view.unavailable === null) load()
    else statsStore.setState({ view })
  })
  load()
  return off
}
