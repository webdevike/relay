import { useEffect, useMemo, type ReactNode } from 'react'
import { createStore, useStore } from 'zustand'
import {
  Card,
  Checkbox,
  ColorInput,
  InputBase,
  MantineProvider,
  Select,
  Textarea,
  TextInput,
  mergeThemeOverrides,
  type ConvertCSSVariablesInput,
  type CSSVariablesResolver,
  type MantineColorShade,
  type MantineColorsTuple,
  type MantineThemeOverride,
} from '@mantine/core'
import { invoke } from '../ipc'
import { theme } from '../theme'
import './theme-components.css'

// Texo's theme model (work/Texo packages/ui/src/texo-theme-provider.tsx): Mantine's default
// theme is the base, a preset config becomes a Mantine theme override plus CSS variables.

export const SIZE_KEYS = ['xs', 'sm', 'md', 'lg', 'xl'] as const
export type ThemeSize = (typeof SIZE_KEYS)[number]
export type ColorScheme = 'light' | 'dark'

export interface SemanticColors {
  body: string
  card: string
  border: string
  dimmed: string
  placeholder: string
  input: string
  muted: string
  surface: string
  popover: string
  text: string
}

// A type alias, not an interface, so it fits the IPC contract's Record<string, unknown>.
export type ThemeConfig = {
  autoContrast: boolean
  chartColors: [string, string, string, string, string]
  cursorType: 'default' | 'pointer'
  effects: {
    cardShadow: string
    controlShadow: string
  }
  defaultRadius: ThemeSize
  focusRing: 'auto' | 'always' | 'never'
  fontFamily: string
  fontFamilyHeadings: string
  fontFamilyMonospace: string
  fontSizes: Record<ThemeSize, string>
  fontSmoothing: boolean
  lineHeights: Record<ThemeSize, string>
  luminanceThreshold: number
  primaryColor: string
  primaryPalette: MantineColorsTuple
  primaryShade: { dark: MantineColorShade; light: MantineColorShade }
  radius: Record<ThemeSize, string>
  respectReducedMotion: boolean
  scale: number
  semantic: Record<ColorScheme, SemanticColors>
  shadows: Record<ThemeSize, string>
  spacing: Record<ThemeSize, string>
}

export interface ThemePreset {
  config: ThemeConfig
  label: string
  value: string
}

const systemSans =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

const blue: MantineColorsTuple = [
  '#e7f5ff',
  '#d0ebff',
  '#a5d8ff',
  '#74c0fc',
  '#4dabf7',
  '#339af0',
  '#228be6',
  '#1c7ed6',
  '#1971c2',
  '#1864ab',
]
const cyan: MantineColorsTuple = [
  '#e3fafc',
  '#c5f6fa',
  '#99e9f2',
  '#66d9e8',
  '#3bc9db',
  '#22b8cf',
  '#15aabf',
  '#1098ad',
  '#0c8599',
  '#0b7285',
]
const teal: MantineColorsTuple = [
  '#e6fcf5',
  '#c3fae8',
  '#96f2d7',
  '#63e6be',
  '#38d9a9',
  '#20c997',
  '#12b886',
  '#0ca678',
  '#099268',
  '#087f5b',
]
const violet: MantineColorsTuple = [
  '#f3f0ff',
  '#e5dbff',
  '#d0bfff',
  '#b197fc',
  '#9775fa',
  '#845ef7',
  '#7950f2',
  '#7048e8',
  '#6741d9',
  '#5f3dc4',
]
const pink: MantineColorsTuple = [
  '#fff0f6',
  '#ffdeeb',
  '#fcc2d7',
  '#faa2c1',
  '#f783ac',
  '#f06595',
  '#e64980',
  '#d6336c',
  '#c2255c',
  '#a61e4d',
]
const orange: MantineColorsTuple = [
  '#fff4e6',
  '#ffe8cc',
  '#ffd8a8',
  '#ffc078',
  '#ffa94d',
  '#ff922b',
  '#fd7e14',
  '#f76707',
  '#e8590c',
  '#d9480f',
]

const defaultConfig: ThemeConfig = {
  // Off, as in stock Mantine: filled controls keep white marks in light mode too.
  autoContrast: false,
  chartColors: ['#228be6', '#15aabf', '#7950f2', '#fd7e14', '#e64980'],
  cursorType: 'pointer',
  effects: {
    cardShadow: '0 1px 3px rgba(0, 0, 0, 0.08)',
    controlShadow: 'none',
  },
  defaultRadius: 'md',
  focusRing: 'auto',
  fontFamily: systemSans,
  fontFamilyHeadings: systemSans,
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSizes: { xs: '0.75rem', sm: '0.875rem', md: '1rem', lg: '1.125rem', xl: '1.25rem' },
  fontSmoothing: true,
  lineHeights: { xs: '1.4', sm: '1.45', md: '1.55', lg: '1.6', xl: '1.65' },
  luminanceThreshold: 0.3,
  primaryColor: 'blue',
  primaryPalette: blue,
  primaryShade: { light: 6, dark: 8 },
  radius: { xs: '0.125rem', sm: '0.25rem', md: '0.5rem', lg: '0.75rem', xl: '1rem' },
  respectReducedMotion: true,
  scale: 1,
  semantic: {
    light: {
      body: '#ffffff',
      border: '#dee2e6',
      card: '#ffffff',
      dimmed: '#868e96',
      input: '#ffffff',
      muted: '#f1f3f5',
      placeholder: '#adb5bd',
      popover: '#ffffff',
      surface: '#f8f9fa',
      text: '#212529',
    },
    dark: {
      body: '#1a1b1e',
      border: '#373a40',
      card: '#1a1b1e',
      dimmed: '#909296',
      input: '#25262b',
      muted: '#2c2e33',
      placeholder: '#5c5f66',
      popover: '#25262b',
      surface: '#25262b',
      text: '#c1c2c5',
    },
  },
  shadows: {
    xs: '0 1px 2px rgba(0, 0, 0, 0.05)',
    sm: '0 1px 3px rgba(0, 0, 0, 0.08)',
    md: '0 4px 12px rgba(0, 0, 0, 0.10)',
    lg: '0 8px 24px rgba(0, 0, 0, 0.12)',
    xl: '0 16px 40px rgba(0, 0, 0, 0.14)',
  },
  spacing: { xs: '0.625rem', sm: '0.75rem', md: '1rem', lg: '1.25rem', xl: '2rem' },
}

function preset(value: string, label: string, overrides: Partial<ThemeConfig>): ThemePreset {
  return {
    value,
    label,
    config: {
      ...defaultConfig,
      ...overrides,
      primaryShade: { ...defaultConfig.primaryShade, ...overrides.primaryShade },
      semantic: {
        light: { ...defaultConfig.semantic.light, ...overrides.semantic?.light },
        dark: { ...defaultConfig.semantic.dark, ...overrides.semantic?.dark },
      },
    },
  }
}

export const THEME_PRESETS: ThemePreset[] = [
  preset('default', 'Default', {}),
  preset('ocean', 'Ocean', {
    primaryColor: 'cyan',
    primaryPalette: cyan,
    defaultRadius: 'lg',
    semantic: {
      light: { ...defaultConfig.semantic.light, body: '#fafdff', surface: '#eef8fc' },
      dark: { ...defaultConfig.semantic.dark, body: '#102027', surface: '#142a33' },
    },
  }),
  preset('forest', 'Forest', {
    primaryColor: 'teal',
    primaryPalette: teal,
    defaultRadius: 'sm',
    semantic: {
      light: { ...defaultConfig.semantic.light, body: '#fbfdfb', surface: '#f0f7f2' },
      dark: { ...defaultConfig.semantic.dark, body: '#17201a', surface: '#1d2921' },
    },
  }),
  preset('violet', 'Violet', {
    primaryColor: 'violet',
    primaryPalette: violet,
    defaultRadius: 'xl',
    semantic: {
      light: { ...defaultConfig.semantic.light, body: '#fdfcff', surface: '#f5f1ff' },
      dark: { ...defaultConfig.semantic.dark, body: '#1d1925', surface: '#282132' },
    },
  }),
  preset('amber-minimal', 'Amber Minimal', {
    effects: {
      cardShadow: 'none',
      controlShadow: 'none',
    },
    primaryColor: 'orange',
    primaryPalette: orange,
    defaultRadius: 'xs',
    fontFamily: 'Inter, Arial, sans-serif',
    fontFamilyHeadings: 'Inter, Arial, sans-serif',
    radius: { xs: '0', sm: '0.125rem', md: '0.25rem', lg: '0.375rem', xl: '0.5rem' },
    shadows: { xs: 'none', sm: 'none', md: 'none', lg: 'none', xl: 'none' },
    spacing: { xs: '0.5rem', sm: '0.625rem', md: '0.875rem', lg: '1.125rem', xl: '1.75rem' },
  }),
  preset('bold-tech', 'Bold Tech', {
    primaryColor: 'violet',
    primaryPalette: violet,
    defaultRadius: 'sm',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontFamilyHeadings: 'Arial Black, Arial, sans-serif',
    fontSizes: {
      xs: '0.6875rem',
      sm: '0.8125rem',
      md: '0.9375rem',
      lg: '1.125rem',
      xl: '1.375rem',
    },
    radius: { xs: '0', sm: '0.2rem', md: '0.35rem', lg: '0.5rem', xl: '0.75rem' },
    shadows: {
      xs: '2px 2px 0 rgba(0, 0, 0, 0.9)',
      sm: '3px 3px 0 rgba(0, 0, 0, 0.9)',
      md: '5px 5px 0 rgba(0, 0, 0, 0.9)',
      lg: '7px 7px 0 rgba(0, 0, 0, 0.9)',
      xl: '10px 10px 0 rgba(0, 0, 0, 0.9)',
    },
    effects: {
      cardShadow: '5px 5px 0 rgba(0, 0, 0, 0.9)',
      controlShadow: '3px 3px 0 rgba(0, 0, 0, 0.9)',
    },
  }),
  preset('bubblegum', 'Bubblegum', {
    primaryColor: 'pink',
    primaryPalette: pink,
    defaultRadius: 'xl',
    fontFamily: 'Trebuchet MS, Arial, sans-serif',
    fontFamilyHeadings: 'Trebuchet MS, Arial, sans-serif',
    radius: { xs: '0.375rem', sm: '0.625rem', md: '0.875rem', lg: '1.25rem', xl: '2rem' },
    shadows: {
      xs: '0 1px 2px rgba(214, 51, 108, 0.08)',
      sm: '0 3px 8px rgba(214, 51, 108, 0.12)',
      md: '0 8px 20px rgba(214, 51, 108, 0.16)',
      lg: '0 14px 32px rgba(214, 51, 108, 0.18)',
      xl: '0 24px 48px rgba(214, 51, 108, 0.22)',
    },
    effects: {
      cardShadow: '0 8px 20px rgba(214, 51, 108, 0.16)',
      controlShadow: '4px 5px 0 rgba(214, 51, 108, 0.32)',
    },
    semantic: {
      light: {
        ...defaultConfig.semantic.light,
        body: '#f8e8f1',
        border: '#d63384',
        card: '#fff0cf',
        input: '#fff0cf',
        muted: '#b2e1eb',
        popover: '#fff8e7',
        surface: '#fff0f6',
        text: '#5b4b4b',
      },
      dark: {
        ...defaultConfig.semantic.dark,
        body: '#281d26',
        border: '#f06595',
        card: '#33252d',
        input: '#33252d',
        muted: '#21444b',
        popover: '#352530',
        surface: '#352530',
        text: '#fff0f6',
      },
    },
  }),
  preset('attio', 'Attio', {
    primaryColor: 'blue',
    primaryPalette: blue,
    defaultRadius: 'md',
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontFamilyHeadings: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    radius: { xs: '0.1875rem', sm: '0.375rem', md: '0.625rem', lg: '0.875rem', xl: '1.25rem' },
    shadows: {
      xs: '0 1px 2px rgba(20, 23, 31, 0.04)',
      sm: '0 2px 8px rgba(20, 23, 31, 0.06)',
      md: '0 12px 32px rgba(20, 23, 31, 0.10)',
      lg: '0 20px 48px rgba(20, 23, 31, 0.12)',
      xl: '0 28px 64px rgba(20, 23, 31, 0.16)',
    },
    effects: {
      cardShadow: 'none',
      controlShadow: 'none',
    },
    semantic: {
      light: {
        ...defaultConfig.semantic.light,
        body: '#ffffff',
        border: '#e6e7ea',
        card: '#ffffff',
        dimmed: '#92959d',
        input: '#ffffff',
        muted: '#f3f4f6',
        placeholder: '#a7aab1',
        popover: '#ffffff',
        surface: '#f7f7f8',
        text: '#202124',
      },
      dark: {
        ...defaultConfig.semantic.dark,
        body: '#17181b',
        border: '#34363c',
        card: '#202126',
        dimmed: '#9699a2',
        input: '#202126',
        muted: '#292b30',
        placeholder: '#6f727a',
        popover: '#24252a',
        surface: '#1d1e22',
        text: '#f1f2f4',
      },
    },
  }),
  preset('caffeine', 'Caffeine', {
    primaryColor: 'orange',
    primaryPalette: orange,
    defaultRadius: 'md',
    fontFamily: 'Georgia, serif',
    fontFamilyHeadings: 'Georgia, serif',
    radius: { xs: '0.125rem', sm: '0.25rem', md: '0.375rem', lg: '0.5rem', xl: '0.75rem' },
    shadows: {
      xs: '0 1px 2px rgba(71, 48, 35, 0.08)',
      sm: '0 2px 6px rgba(71, 48, 35, 0.10)',
      md: '0 6px 16px rgba(71, 48, 35, 0.12)',
      lg: '0 12px 28px rgba(71, 48, 35, 0.14)',
      xl: '0 20px 40px rgba(71, 48, 35, 0.18)',
    },
    effects: {
      cardShadow: '0 6px 16px rgba(71, 48, 35, 0.12)',
      controlShadow: '2px 3px 0 rgba(71, 48, 35, 0.18)',
    },
    semantic: {
      light: {
        ...defaultConfig.semantic.light,
        body: '#fffaf3',
        border: '#d8c3ad',
        surface: '#f4eadf',
        text: '#473023',
      },
      dark: {
        ...defaultConfig.semantic.dark,
        body: '#211914',
        border: '#6f5545',
        surface: '#2d211a',
        text: '#f5e7d8',
      },
    },
  }),
]

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

export function themeOverrideFor(config: ThemeConfig): MantineThemeOverride {
  return {
    autoContrast: config.autoContrast,
    colors: { [config.primaryColor]: config.primaryPalette },
    components: {
      Card: Card.extend({ classNames: { root: 'eva-theme-card' } }),
      Checkbox: Checkbox.extend({ classNames: { input: 'eva-theme-checkbox-input' } }),
      ColorInput: ColorInput.extend({ classNames: { input: 'eva-theme-input' } }),
      InputBase: InputBase.extend({ classNames: { input: 'eva-theme-input' } }),
      // A plain entry, not Menu.extend: menus render only through overlay/EvaMenu.
      Menu: { classNames: { dropdown: 'eva-theme-popover' } },
      Select: Select.extend({ classNames: { input: 'eva-theme-input' } }),
      Textarea: Textarea.extend({ classNames: { input: 'eva-theme-input' } }),
      TextInput: TextInput.extend({ classNames: { input: 'eva-theme-input' } }),
    },
    cursorType: config.cursorType,
    defaultRadius: config.defaultRadius,
    focusRing: config.focusRing,
    fontFamily: config.fontFamily,
    fontFamilyMonospace: config.fontFamilyMonospace,
    fontSizes: config.fontSizes,
    fontSmoothing: config.fontSmoothing,
    headings: { fontFamily: config.fontFamilyHeadings },
    lineHeights: config.lineHeights,
    luminanceThreshold: config.luminanceThreshold,
    primaryColor: config.primaryColor,
    primaryShade: config.primaryShade,
    radius: config.radius,
    respectReducedMotion: config.respectReducedMotion,
    scale: config.scale,
    shadows: config.shadows,
    spacing: config.spacing,
  }
}

function schemeVariables(config: ThemeConfig, scheme: ColorScheme): Record<string, string> {
  const colors = config.semantic[scheme]
  return {
    '--mantine-color-body': colors.body,
    '--mantine-color-default': colors.body,
    '--mantine-color-default-border': colors.border,
    '--mantine-color-dimmed': colors.dimmed,
    '--mantine-color-placeholder': colors.placeholder,
    '--mantine-color-text': colors.text,
    '--eva-color-card': colors.card,
    '--eva-color-input': colors.input,
    '--eva-color-muted': colors.muted,
    '--eva-color-popover': colors.popover,
    '--eva-color-surface': colors.surface,
    '--eva-card-shadow': config.effects.cardShadow,
    '--eva-control-shadow': config.effects.controlShadow,
  }
}

export function cssVariablesFor(config: ThemeConfig): ConvertCSSVariablesInput {
  return {
    variables: {
      '--eva-chart-1': config.chartColors[0],
      '--eva-chart-2': config.chartColors[1],
      '--eva-chart-3': config.chartColors[2],
      '--eva-chart-4': config.chartColors[3],
      '--eva-chart-5': config.chartColors[4],
    },
    light: schemeVariables(config, 'light'),
    dark: schemeVariables(config, 'dark'),
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const config = useStore(themeStore, (s) => s.present)
  const mergedTheme = useMemo(() => mergeThemeOverrides(theme, themeOverrideFor(config)), [config])
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
    <MantineProvider theme={mergedTheme} cssVariablesResolver={resolver} forceColorScheme={scheme}>
      {children}
    </MantineProvider>
  )
}
