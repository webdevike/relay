import { createStore, useStore } from 'zustand'
import { notifications } from '@mantine/notifications'
import {
  defaultDoc,
  resolveMode,
  resolveTheme,
  type Appearance,
  type ThemeDoc,
} from '@evaos/theme-core'
import { invoke } from '../ipc'
import { applyTheme, reportBackground } from './applier'

export interface ThemeState {
  appearance: Appearance
  resolved: 'light' | 'dark'
  doc: ThemeDoc
  baseSaving: boolean
  baseError: string | null
}

const QUERY = '(prefers-color-scheme: dark)'

function prefersDark(): boolean {
  return window.matchMedia(QUERY).matches
}

export const themeStore = createStore<ThemeState>(() => ({
  appearance: 'system',
  resolved: 'dark',
  doc: defaultDoc(),
  baseSaving: false,
  baseError: null,
}))

let mql: MediaQueryList | null = null
let mqlHandler: (() => void) | null = null

function apply(appearance: Appearance, doc: ThemeDoc): void {
  const mode = resolveMode(appearance, prefersDark())
  const resolved = resolveTheme(doc, mode)
  const root = document.documentElement
  root.dataset['appearance'] = appearance
  applyTheme(root, resolved)
  themeStore.setState({ appearance, resolved: mode, doc })
  reportBackground(resolved)
}

function attachMedia(): void {
  if (mql) return
  mql = window.matchMedia(QUERY)
  mqlHandler = () => {
    const s = themeStore.getState()
    if (s.appearance === 'system') apply('system', s.doc)
  }
  mql.addEventListener('change', mqlHandler)
}

export function initTheme(appearance: Appearance, doc: ThemeDoc = defaultDoc()): void {
  attachMedia()
  themeStore.setState({ baseSaving: false, baseError: null })
  apply(appearance, doc)
}

export function setAppearance(appearance: Appearance): void {
  attachMedia()
  const doc = themeStore.getState().doc
  apply(appearance, { ...doc, app: { ...doc.app, appearance } })
  void invoke('theme.setAppearance', { appearance }).then(
    (r) => {
      if (!r.ok) notifySaveFailure()
    },
    () => notifySaveFailure(),
  )
}

/** Applies immediately, then restores only the family if persistence fails. */
export async function setThemeBase(base: string): Promise<void> {
  const previous = themeStore.getState()
  if (previous.baseSaving || previous.doc.base === base) return
  themeStore.setState({ baseSaving: true, baseError: null })
  apply(previous.appearance, { ...previous.doc, base })
  try {
    const result = await invoke('theme.setBase', { base })
    if (!result.ok) throw new Error(result.error.message)
    themeStore.setState({ baseSaving: false })
  } catch {
    const current = themeStore.getState()
    apply(current.appearance, { ...current.doc, base: previous.doc.base })
    themeStore.setState({
      baseSaving: false,
      baseError: 'Could not save the theme. Your previous theme has been restored.',
    })
  }
}

function notifySaveFailure(): void {
  notifications.show({
    color: 'red',
    message:
      'Could not save your settings. Check that the EvaOS config folder is writable, then try again.',
  })
}

export function useTheme<T>(selector: (state: ThemeState) => T): T {
  return useStore(themeStore, selector)
}

export function useAppearance(): Appearance {
  return useStore(themeStore, (s) => s.appearance)
}

export function useResolvedMode(): 'light' | 'dark' {
  return useStore(themeStore, (s) => s.resolved)
}

export function disposeThemeListeners(): void {
  if (mql && mqlHandler) mql.removeEventListener('change', mqlHandler)
  mql = null
  mqlHandler = null
}
