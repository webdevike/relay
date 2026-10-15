import { COLOR_KEYS, type ColorKey } from './keys'
import type { ResolvedTheme } from './resolve'

const UI_FALLBACK = 'ui-sans-serif, -apple-system, system-ui, sans-serif'
const CODE_FALLBACK = 'ui-monospace, Menlo, monospace'

/** `accent.background` becomes `--eva-c-accent-background`; underscores are kept. */
export function varName(key: ColorKey | string): string {
  return `--eva-c-${key.replaceAll('.', '-')}`
}

export function colorVars(resolved: ResolvedTheme): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of COLOR_KEYS) out[varName(key)] = resolved.colors[key]
  return out
}

export function shapeVars(resolved: ResolvedTheme): Record<string, string> {
  return {
    '--eva-font-ui': `"${resolved.font.family}", ${UI_FALLBACK}`,
    '--eva-font-code': `"${resolved.monoFont.family}", ${CODE_FALLBACK}`,
    '--eva-font-size': `${resolved.font.size}px`,
    '--eva-font-code-size': `${resolved.monoFont.size}px`,
    '--eva-radius': `${resolved.radius}px`,
    '--eva-radius-lg': `${resolved.radiusLg}px`,
    '--eva-shadow': resolved.shadow ? '0 1px 2px rgb(0 0 0 / 0.2)' : 'none',
  }
}
