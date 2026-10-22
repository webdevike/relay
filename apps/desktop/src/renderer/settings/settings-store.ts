import { createStore, useStore } from 'zustand'
import { notifications } from '@mantine/notifications'
import { invoke } from '../ipc'

export interface SettingsState {
  show_thinking: boolean
  show_tools: boolean
  harness: Harness
  loaded: boolean
}

export type Harness = 'omp' | 'claude'

export type SettingKey = 'show_thinking' | 'show_tools'

export const SAVE_ERROR_COPY =
  'Could not save your settings. Check that the EvaOS config folder is writable, then try again.'

export const settingsStore = createStore<SettingsState>(() => ({
  show_thinking: false,
  show_tools: false,
  harness: 'omp',
  loaded: false,
}))

let started: Promise<void> | null = null

/** Loads chat.json settings once; a failed load keeps the defaults. */
export function startSettings(): Promise<void> {
  started ??= (async () => {
    try {
      const r = await invoke('settings.load', {})
      if (r.ok) {
        settingsStore.setState({
          show_thinking: r.value.show_thinking,
          show_tools: r.value.show_tools,
          harness: r.value.harness,
          loaded: true,
        })
        return
      }
    } catch {
      // keep defaults
    }
    settingsStore.setState({ loaded: true })
  })()
  return started
}

const chains: Record<SettingKey | 'harness', Promise<void>> = {
  show_thinking: Promise.resolve(),
  show_tools: Promise.resolve(),
  harness: Promise.resolve(),
}

function fail(): void {
  notifications.show({ color: 'red', message: SAVE_ERROR_COPY, autoClose: 8000 })
}

/** Optimistic: applies at once, saves in order per key, reverts with a toast on failure. */
export function setSetting(key: SettingKey, value: boolean): Promise<void> {
  return save(key, value)
}

/** Which harness new chats use. Same optimistic save and rollback as the switches. */
export function setHarness(value: Harness): Promise<void> {
  return save('harness', value)
}

function save<K extends SettingKey | 'harness'>(key: K, value: SettingsState[K]): Promise<void> {
  const previous = settingsStore.getState()[key]
  settingsStore.setState({ [key]: value } as Pick<SettingsState, K>)
  const run = async (): Promise<void> => {
    try {
      const r = await invoke('settings.save', { [key]: value })
      if (r.ok) {
        settingsStore.setState({ [key]: r.value[key] } as Pick<SettingsState, K>)
        return
      }
    } catch {
      // fall through to revert
    }
    settingsStore.setState({ [key]: previous } as Pick<SettingsState, K>)
    fail()
  }
  chains[key] = chains[key].then(run, run)
  return chains[key]
}

export function useSettings<T>(selector: (s: SettingsState) => T): T {
  return useStore(settingsStore, selector)
}

/** Test helper. */
export function resetSettingsForTest(): void {
  started = null
  chains.show_thinking = Promise.resolve()
  chains.show_tools = Promise.resolve()
  chains.harness = Promise.resolve()
  settingsStore.setState({
    show_thinking: false,
    show_tools: false,
    harness: 'omp',
    loaded: false,
  })
}
