import data from './catalog-data.json'
import { EVAOS_DARK, EVAOS_LIGHT } from './bundled'
import type { ColorKey } from './keys'

// catalog-data.json is copied from apps/evaos/assets/themes/{kit,bubblegum,bold-tech}.json.
// Kit themes are Apache-2.0 (see LICENSE-APACHE); EvaOS presets retain their author metadata.
// Matches native src/theme.rs: paired families only, last variant per mode wins.
// All data ships with Electron; the native repository is never read at runtime.
export interface ThemePreset {
  colors: Partial<Record<ColorKey, string>>
  radius?: number
  'radius.lg'?: number
  shadow?: boolean
}

export const THEME_CATALOG: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'EvaOS', name: 'EvaOS' },
  ...data.map(({ name }) => ({ id: name, name })),
]

const families: Record<string, { light: ThemePreset; dark: ThemePreset } | undefined> =
  Object.fromEntries(data.map((family) => [family.name, family]))

export function hasThemeFamily(base: string): boolean {
  return base === 'EvaOS' || Object.hasOwn(families, base)
}

export function getThemePreset(base: string, mode: 'light' | 'dark'): ThemePreset | undefined {
  if (base === 'EvaOS') {
    const bundled = mode === 'dark' ? EVAOS_DARK : EVAOS_LIGHT
    return {
      colors: bundled.colors,
      radius: bundled.radius,
      'radius.lg': bundled.radiusLg,
      shadow: bundled.shadow,
    }
  }
  return Object.hasOwn(families, base) ? families[base]?.[mode] : undefined
}
