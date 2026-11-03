import { createStore, useStore } from 'zustand'
import { DEFAULT_LINK_PREFS, type LinkPrefs } from '@evaos/contract'
import { invoke, on } from '../ipc'

export interface LinkPrefsState {
  prefs: LinkPrefs
  /** Installed apps an app opener can name; empty until loaded, so every app rule opens here. */
  apps: string[]
  loaded: boolean
}

export const linkPrefsStore = createStore<LinkPrefsState>(() => ({
  prefs: DEFAULT_LINK_PREFS,
  apps: [],
  loaded: false,
}))

export function useLinkPrefs<T>(pick: (s: LinkPrefsState) => T): T {
  return useStore(linkPrefsStore, pick)
}

let started: Promise<void> | null = null

/** Loads Settings > Links once and follows later saves; a failed load keeps the defaults. */
export function startLinks(): Promise<void> {
  started ??= (async () => {
    on('links.changed', ({ prefs, apps }) => linkPrefsStore.setState({ prefs, apps, loaded: true }))
    try {
      const r = await invoke('links.get', {})
      if (r.ok) linkPrefsStore.setState({ ...r.value, loaded: true })
    } catch {
      /* keep the defaults */
    }
  })()
  return started
}

/** Saves new rules; answers an error message when the save failed. */
export async function saveLinkPrefs(prefs: LinkPrefs): Promise<string | null> {
  const before = linkPrefsStore.getState().prefs
  linkPrefsStore.setState({ prefs })
  try {
    const r = await invoke('links.set', { prefs })
    if (r.ok) return null
  } catch {
    /* fall through */
  }
  linkPrefsStore.setState({ prefs: before })
  return 'Could not save your link rules. Check that the config folder is writable, then try again.'
}
