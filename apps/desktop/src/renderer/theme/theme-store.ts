import { createStore, useStore } from 'zustand'
import { notifications } from '@mantine/notifications'
import {
  defaultDoc,
  resolveMode,
  resolveTheme,
  serializeThemeDoc,
  validateThemeDoc,
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
  docSaving: boolean
  docError: string | null
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
  docSaving: false,
  docError: null,
}))

let mql: MediaQueryList | null = null
let mqlHandler: (() => void) | null = null
let docWrites: Promise<void> = Promise.resolve()
let docRevision = 0
let pendingDocWrites = 0
let persistedDoc = defaultDoc()

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
  if (doc.app.appearance !== appearance) doc = { ...doc, app: { ...doc.app, appearance } }
  docRevision += 1
  persistedDoc = doc
  themeStore.setState({ baseSaving: false, baseError: null, docSaving: false, docError: null })
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
  if (previous.baseSaving || previous.docSaving || previous.doc.base === base) return
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

/** Apply every edit immediately; serialize persistence and restore the last successful doc on failure. */
export async function saveThemeDoc(doc: ThemeDoc): Promise<void> {
  const wireDoc = serializeThemeDoc(doc)
  validateThemeDoc(wireDoc)
  const previous = themeStore.getState()
  if (previous.baseSaving) throw new Error('Wait for the theme preset to finish saving.')
  if (pendingDocWrites === 0) persistedDoc = previous.doc
  const revision = ++docRevision
  pendingDocWrites += 1
  themeStore.setState({ docSaving: true, docError: null })
  apply(doc.app.appearance, doc)
  const write = docWrites.then(async () => {
    // An appearance switch made after this edit must not be undone by a queued full-doc write.
    const appearance = themeStore.getState().appearance
    const result = await invoke('theme.saveDoc', {
      doc: { ...wireDoc, app: { ...(wireDoc.app as Record<string, unknown>), appearance } },
    })
    if (!result.ok) throw new Error(result.error.message)
    persistedDoc = appearance === doc.app.appearance ? doc : { ...doc, app: { ...doc.app, appearance } }
  })
  docWrites = write.catch(() => {})
  try {
    await write
  } catch (error) {
    if (revision === docRevision) {
      const current = themeStore.getState()
      const appearance = current.appearance === doc.app.appearance ? persistedDoc.app.appearance : current.appearance
      const base = current.doc.base === doc.base ? persistedDoc.base : current.doc.base
      apply(appearance, { ...persistedDoc, base, app: { ...persistedDoc.app, appearance } })
      themeStore.setState({ docError: 'Could not save the theme. Your previous theme has been restored.' })
    }
    throw error
  } finally {
    pendingDocWrites -= 1
    themeStore.setState({ docSaving: pendingDocWrites > 0 })
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
