import { createStore, useStore } from 'zustand'
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from '@evaos/contract'
import { invoke, on } from '../ipc'

export interface NotificationsState {
  prefs: NotificationPrefs
  loaded: boolean
}

export const notificationsStore = createStore<NotificationsState>(() => ({
  prefs: DEFAULT_NOTIFICATION_PREFS,
  loaded: false,
}))

export function useNotificationPrefs<T>(pick: (s: NotificationsState) => T): T {
  return useStore(notificationsStore, pick)
}

let started: Promise<void> | null = null

/** Loads Settings > Notifications once and follows later saves; a failed load keeps the defaults. */
export function startNotificationPrefs(): Promise<void> {
  started ??= (async () => {
    on('notifications.changed', (prefs) => notificationsStore.setState({ prefs, loaded: true }))
    try {
      const r = await invoke('notifications.get', {})
      if (r.ok) notificationsStore.setState({ prefs: r.value, loaded: true })
    } catch {
      /* keep the defaults */
    }
  })()
  return started
}

/** Saves a change (the switch, one assistant's mute); the page shows it at once and undoes it on failure. */
export async function saveNotificationPrefs(patch: Partial<NotificationPrefs>): Promise<boolean> {
  const before = notificationsStore.getState().prefs
  notificationsStore.setState({ prefs: { ...before, ...patch } })
  try {
    const r = await invoke('notifications.set', patch)
    if (r.ok) {
      notificationsStore.setState({ prefs: r.value })
      return true
    }
  } catch {
    /* fall through */
  }
  notificationsStore.setState({ prefs: before })
  return false
}

/** Shows a test notification now; false when this copy cannot show one. */
export async function sendTestNotification(): Promise<boolean> {
  try {
    const r = await invoke('notifications.test', {})
    return r.ok && r.value.shown
  } catch {
    return false
  }
}

/** Test seam. */
export function resetNotificationPrefsForTests(): void {
  started = null
  notificationsStore.setState({ prefs: DEFAULT_NOTIFICATION_PREFS, loaded: false })
}
