import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { UsageSnapshot } from '@evaos/contract'
import { invoke, on } from '../ipc'

/** Main owns polling; the renderer mirrors its snapshot. Null until the first one arrives. */
export const usageStore = createStore<{ snapshot: UsageSnapshot | null }>(() => ({
  snapshot: null,
}))

export function useUsage<T>(selector: (s: UsageSnapshot | null) => T): T {
  return useStore(usageStore, (s) => selector(s.snapshot))
}

export async function refreshUsage(): Promise<void> {
  const r = await invoke('usage.refresh', {})
  if (r.ok) usageStore.setState({ snapshot: r.value })
}

export function startUsage(): () => void {
  const off = on('usage.changed', (snapshot) => usageStore.setState({ snapshot }))
  void invoke('usage.get', {}).then((r) => {
    if (r.ok) usageStore.setState({ snapshot: r.value })
  })
  return off
}
