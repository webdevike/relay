import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { ActivityItem } from '@evaos/chat-core/activity'
import { invoke, on } from '../ipc'

/** What agents are running, as the host's latest snapshot has it (the same on every Mac). */
export interface ActivityState {
  up: boolean
  items: readonly ActivityItem[]
}

export const activityStore = createStore<ActivityState>(() => ({ up: false, items: [] }))

export function useActivity<T>(selector: (s: ActivityState) => T): T {
  return useStore(activityStore, selector)
}

let watchers = 0
let stop: (() => void) | null = null

/**
 * Follows the host's activity list while anything that draws it is mounted: asks for it now (main
 * asks the host again after every reconnect) and takes each push.
 */
export function startActivity(): () => void {
  if (watchers++ === 0) {
    const off = on('activity.changed', (v) => activityStore.setState({ up: v.up, items: v.items }))
    stop = off
    void invoke('activity.watch', {}).then((r) => {
      if (r.ok) activityStore.setState({ up: r.value.up, items: r.value.items })
    })
  }
  return () => {
    if (--watchers === 0) {
      stop?.()
      stop = null
    }
  }
}

/** The list, followed for as long as the calling component is mounted. */
export function useActivityItems(): readonly ActivityItem[] {
  useEffect(() => startActivity(), [])
  return useActivity((s) => s.items)
}
