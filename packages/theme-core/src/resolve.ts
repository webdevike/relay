import { BASE_DARK } from './base-dark'
import { BASE_LIGHT } from './base-light'
import { EVAOS_DARK, EVAOS_LIGHT } from './bundled'
import flexoki from './flexoki.json'
import type { ThemeDoc } from './doc'
import { COLOR_KEYS, type ColorKey } from './keys'

export interface ResolvedTheme {
  mode: 'light' | 'dark'
  colors: Record<ColorKey, string>
  font: { family: string; size: number }
  monoFont: { family: string; size: number }
  radius: number
  radiusLg: number
  shadow: boolean
}

/** Layers per key: kit base, selected bundled preset, shared edits, mode edits. Pure. */
export function resolveTheme(doc: ThemeDoc, mode: 'light' | 'dark'): ResolvedTheme {
  const bundled = mode === 'dark' ? EVAOS_DARK : EVAOS_LIGHT
  const base = mode === 'dark' ? BASE_DARK : BASE_LIGHT
  const selected =
    doc.base === 'Flexoki' ? flexoki.themes.find((theme) => theme.mode === mode) : undefined
  const presetColors = selected?.colors as Partial<Record<ColorKey, string>> | undefined
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
    font: { ...bundled.font },
    monoFont: { ...bundled.monoFont },
    radius: bundled.radius,
    radiusLg: bundled.radiusLg,
    shadow: bundled.shadow,
  }
}
