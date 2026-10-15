import { BASE_DARK } from './base-dark'
import { BASE_LIGHT } from './base-light'
import { EVAOS_DARK, EVAOS_LIGHT } from './bundled'
import { getThemePreset } from './catalog'
import type { ThemeDoc } from './doc'
import { COLOR_KEYS, type ColorKey } from './keys'
import { resolveHighlight, type HighlightTheme } from './highlight'

export interface ResolvedTheme {
  mode: 'light' | 'dark'
  colors: Record<ColorKey, string>
  font: { family: string; size: number }
  monoFont: { family: string; size: number }
  radius: number
  radiusLg: number
  shadow: boolean
  highlight: HighlightTheme
}

/** Layers per key: kit base, selected bundled preset, shared edits, mode edits. Pure. */
export function resolveTheme(doc: ThemeDoc, mode: 'light' | 'dark'): ResolvedTheme {
  const bundled = mode === 'dark' ? EVAOS_DARK : EVAOS_LIGHT
  const base = mode === 'dark' ? BASE_DARK : BASE_LIGHT
  const selected = getThemePreset(doc.base, mode)
  const presetColors = selected?.colors
  const modeEdits = (mode === 'dark' ? doc.dark : doc.light).edits
  const colors = {} as Record<ColorKey, string>
  for (const key of COLOR_KEYS) {
    colors[key] =
      modeEdits[key] ??
      doc.shared[key] ??
      presetColors?.[key] ??
      (selected ? base[key] : (bundled.colors[key] ?? base[key]))
  }
  return {
    mode,
    colors,
    font: { family: doc.shared['font.family'] ?? bundled.font.family, size: doc.shared['font.size'] ?? bundled.font.size },
    monoFont: { family: doc.shared['mono_font.family'] ?? bundled.monoFont.family, size: doc.shared['mono_font.size'] ?? bundled.monoFont.size },
    radius: doc.shared.radius ?? selected?.radius ?? bundled.radius,
    radiusLg: doc.shared['radius.lg'] ?? selected?.['radius.lg'] ?? bundled.radiusLg,
    shadow: doc.shared.shadow ?? selected?.shadow ?? bundled.shadow,
    highlight: resolveHighlight(doc.base, mode, modeEdits.highlight, colors),
  }
}

/** Both fully resolved modes in the native, portable gpui-kit theme-set format. */
export function exportTheme(doc: ThemeDoc) {
  return {
    $schema: 'https://github.com/longbridge/gpui-kit/raw/refs/heads/main/.theme-schema.json',
    name: 'EvaOS',
    author: 'Isaac Weber',
    themes: (['light', 'dark'] as const).map((mode) => {
      const theme = resolveTheme(doc, mode)
      return {
        name: mode === 'light' ? 'EvaOS Light' : 'EvaOS Dark',
        mode,
        'font.family': theme.font.family,
        'font.size': theme.font.size,
        'mono_font.family': theme.monoFont.family,
        'mono_font.size': theme.monoFont.size,
        radius: theme.radius,
        'radius.lg': theme.radiusLg,
        shadow: theme.shadow,
        colors: theme.colors,
        highlight: theme.highlight,
      }
    }),
  }
}
