import { useEffect, useMemo, type ReactNode } from 'react'
import { createStore, useStore } from 'zustand'
import { MantineProvider, type CSSVariablesResolver } from '@mantine/core'
import {
  THEME_PRESETS,
  cssVariablesFor,
  themeOverrideFor,
  type ColorScheme,
  type ThemeConfig,
  type ThemePreset,
} from '@relay/widget-runtime/theme'
import '@relay/widget-runtime/theme-components.css'
import { invoke } from '../ipc'

// The theme model, presets and their Mantine override live in @relay/widget-runtime/theme, shared
// with agent-made widgets; this module is the editor's store, persistence and provider.

/**
 * A theme Isaac saved: his own (`value` starts with `user-`) or his version of a built-in preset
 * (same `value` as the preset, replacing it until he resets it).
 */
export interface UserTheme {
  config: ThemeConfig
  label: string
  value: string
}

interface ThemeHistory {
  future: ThemeConfig[]
  past: ThemeConfig[]
  present: ThemeConfig
  /** The theme the edits started from; `present` differs from its saved config while unsaved. */
  preset: string
  themes: UserTheme[]
  /** Light or dark: Isaac's appearance, independent of the preset (a preset never changes it). */
  colorScheme: ColorScheme
}

export interface SavedTheme {
  config: ThemeConfig
  preset: string
  themes: UserTheme[]
  colorScheme: ColorScheme
}

// A store rather than Texo's component state, so the boot path and e2e hooks can reach it.
export const themeStore = createStore<ThemeHistory>(() => ({
  future: [],
  past: [],
  present: THEME_PRESETS[0]!.config,
  preset: THEME_PRESETS[0]!.value,
  themes: [],
  colorScheme: 'light',
}))

const isScheme = (v: unknown): v is ColorScheme => v === 'light' || v === 'dark'

/** A saved config merged over the Default preset, so keys added since it was saved get values. */
function configFrom(value: unknown): ThemeConfig {
  // Older files kept the scheme inside the config; it moved out of the config.
  const { colorScheme: _legacy, ...rest } = value as Partial<ThemeConfig> & {
    colorScheme?: unknown
  }
  return { ...THEME_PRESETS[0]!.config, ...rest }
}

function themesFrom(value: unknown): UserTheme[] {
  if (!Array.isArray(value)) return []
  const out: UserTheme[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const { value: name, label, config } = item as Record<string, unknown>
    if (typeof name !== 'string' || typeof label !== 'string') continue
    if (typeof config !== 'object' || config === null) continue
    if (out.some((t) => t.value === name)) continue
    out.push({ value: name, label, config: configFrom(config) })
  }
  return out
}

/** Persisted state merged over the Default preset, as Texo restores it; anything else is ignored. */
export function parseSavedTheme(value: unknown): SavedTheme | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { config, preset: name, colorScheme, themes } = value as Record<string, unknown>
  if (typeof config !== 'object' || config === null || typeof name !== 'string') return undefined
  const legacy = (config as { colorScheme?: unknown }).colorScheme
  const saved = themesFrom(themes)
  const known = THEME_PRESETS.some((p) => p.value === name) || saved.some((t) => t.value === name)
  return {
    config: configFrom(config),
    // Older builds marked any edit 'custom' and lost the theme it started from.
    preset: known ? name : THEME_PRESETS[0]!.value,
    themes: saved,
    colorScheme: isScheme(colorScheme) ? colorScheme : isScheme(legacy) ? legacy : 'light',
  }
}

/** Replaces the whole history without persisting: the seed, not an edit. */
export function seedTheme(initial: SavedTheme | undefined): void {
  themeStore.setState({
    future: [],
    past: [],
    present: initial?.config ?? THEME_PRESETS[0]!.config,
    preset: initial?.preset ?? THEME_PRESETS[0]!.value,
    themes: initial?.themes ?? [],
    colorScheme: initial?.colorScheme ?? 'light',
  })
}

/** Built-in presets (with Isaac's saved versions in their place) followed by his own themes. */
export function allThemes(themes: UserTheme[]): ThemePreset[] {
  const byValue = new Map(themes.map((t) => [t.value, t]))
  return [
    ...THEME_PRESETS.map((p) => byValue.get(p.value) ?? p),
    ...themes.filter((t) => !THEME_PRESETS.some((p) => p.value === t.value)),
  ]
}

export const isBuiltIn = (value: string): boolean => THEME_PRESETS.some((p) => p.value === value)

/** Deep equality that ignores key order: a config read back from theme.json orders keys its own way. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  const rb = b as Record<string, unknown>
  return ka.every((k) => k in rb && sameValue((a as Record<string, unknown>)[k], rb[k]))
}

const sameConfig = (a: ThemeConfig, b: ThemeConfig): boolean => sameValue(a, b)

/** Whether the editor differs from the saved config of the theme it started from. */
export function isDirty(state: Pick<ThemeHistory, 'present' | 'preset' | 'themes'>): boolean {
  const base = allThemes(state.themes).find((t) => t.value === state.preset)
  return !base || !sameConfig(base.config, state.present)
}

export function updateConfig(update: (config: ThemeConfig) => ThemeConfig): void {
  themeStore.setState((current) => ({
    future: [],
    past: [...current.past, current.present],
    present: update(current.present),
  }))
}

export function applyPreset(presetName: string): void {
  const selected = allThemes(themeStore.getState().themes).find((t) => t.value === presetName)
  if (!selected) return
  themeStore.setState((current) => ({
    future: [],
    past: [...current.past, current.present],
    present: selected.config,
    preset: selected.value,
  }))
}

/** Saves the edits into the theme they started from (a built-in keeps its name, now his version). */
export function saveTheme(): void {
  themeStore.setState((current) => {
    const base = allThemes(current.themes).find((t) => t.value === current.preset)
    const label = base?.label ?? 'Untitled theme'
    const entry: UserTheme = { value: current.preset, label, config: current.present }
    const exists = current.themes.some((t) => t.value === current.preset)
    return {
      themes: exists
        ? current.themes.map((t) => (t.value === current.preset ? entry : t))
        : [...current.themes, entry],
    }
  })
}

export function themeSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'theme'
}

/** Saves the editor as a new theme of his own and switches to it. Returns its value. */
export function saveThemeAs(label: string): string {
  const name = label.trim().slice(0, 80) || 'Untitled theme'
  const taken = new Set(allThemes(themeStore.getState().themes).map((t) => t.value))
  const stem = `user-${themeSlug(name)}`
  let value = stem
  for (let n = 2; taken.has(value); n++) value = `${stem}-${n}`
  themeStore.setState((current) => ({
    themes: [...current.themes, { value, label: name, config: current.present }],
    preset: value,
  }))
  return value
}

/** A built-in goes back to how it ships; the editor follows when it's the current theme. */
export function resetTheme(value: string): void {
  const original = THEME_PRESETS.find((p) => p.value === value)
  if (!original) return
  themeStore.setState((current) => ({
    themes: current.themes.filter((t) => t.value !== value),
    ...(current.preset === value
      ? { past: [...current.past, current.present], future: [], present: original.config }
      : {}),
  }))
}

/** Removes one of his own themes; when it's the current one the editor goes to Default. */
export function deleteTheme(value: string): void {
  if (isBuiltIn(value)) return
  themeStore.setState((current) => {
    const themes = current.themes.filter((t) => t.value !== value)
    if (current.preset !== value) return { themes }
    const fallback = allThemes(themes)[0]!
    return {
      themes,
      preset: fallback.value,
      past: [...current.past, current.present],
      future: [],
      present: fallback.config,
    }
  })
}

export function undo(): void {
  themeStore.setState((current) => {
    const previous = current.past.at(-1)
    if (!previous) return current
    return {
      future: [current.present, ...current.future],
      past: current.past.slice(0, -1),
      present: previous,
    }
  })
}

export function redo(): void {
  themeStore.setState((current) => {
    const next = current.future[0]
    if (!next) return current
    return {
      future: current.future.slice(1),
      past: [...current.past, current.present],
      present: next,
    }
  })
}

/** Switches light or dark only: the preset and the edit history stay as they are. */
export function setColorScheme(colorScheme: ColorScheme): void {
  themeStore.setState({ colorScheme })
}

let unsubscribePersist: (() => void) | null = null

/** Saves every committed change to theme.json, as Texo's onChange writes localStorage. */
export function persistTheme(): void {
  unsubscribePersist?.()
  unsubscribePersist = themeStore.subscribe((state, previous) => {
    if (
      state.present === previous.present &&
      state.preset === previous.preset &&
      state.themes === previous.themes &&
      state.colorScheme === previous.colorScheme
    )
      return
    void invoke('theme.save', {
      config: state.present,
      preset: state.preset,
      themes: state.themes,
      colorScheme: state.colorScheme,
    }).catch(() => {})
  })
}

export function useThemeConfig() {
  const config = useStore(themeStore, (s) => s.present)
  const presetName = useStore(themeStore, (s) => s.preset)
  const themes = useStore(themeStore, (s) => s.themes)
  const dirty = useStore(themeStore, isDirty)
  const canUndo = useStore(themeStore, (s) => s.past.length > 0)
  const canRedo = useStore(themeStore, (s) => s.future.length > 0)
  const options = useMemo(() => allThemes(themes), [themes])
  return {
    applyPreset,
    canRedo,
    canUndo,
    config,
    dirty,
    options,
    preset: presetName,
    redo,
    themes,
    undo,
    updateConfig,
  }
}

export function useColorScheme(): ColorScheme {
  return useStore(themeStore, (s) => s.colorScheme)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const config = useStore(themeStore, (s) => s.present)
  const mantineTheme = useMemo(() => themeOverrideFor(config), [config])
  const resolver = useMemo<CSSVariablesResolver>(() => () => cssVariablesFor(config), [config])
  const scheme = useStore(themeStore, (s) => s.colorScheme)
  const body = config.semantic[scheme].body
  useEffect(() => {
    // Shell CSS and e2e read the scheme here; the window behind the renderer follows the body color.
    document.documentElement.dataset['resolved'] = scheme
    void invoke('app.setBackground', { color: body }).catch(() => {})
  }, [scheme, body])
  useEffect(() => {
    document.documentElement.dataset['focusRing'] = config.focusRing
  }, [config.focusRing])
  return (
    <MantineProvider theme={mantineTheme} cssVariablesResolver={resolver} forceColorScheme={scheme}>
      {children}
    </MantineProvider>
  )
}
