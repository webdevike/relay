import { defaultDoc, resolveMode, resolveTheme, type Appearance } from '@evaos/theme-core'
import { invoke } from '../ipc'
import { applyTheme } from './applier'
import { initMotion } from './motion'
import { initTheme, themeStore } from './theme-store'

/** Applies the system-resolved bundled theme first so the first paint is never unstyled. */
export async function bootstrapTheme(): Promise<{ resolved: 'light' | 'dark' }> {
  try {
    const mode = resolveMode('system', window.matchMedia('(prefers-color-scheme: dark)').matches)
    applyTheme(document.documentElement, resolveTheme(defaultDoc(), mode))
  } catch {
    // fall through; initTheme below applies again
  }
  let appearance: Appearance = 'system'
  let noMotion = false
  let e2e = false
  try {
    const [theme, info] = await Promise.all([invoke('theme.load', {}), invoke('app.info', {})])
    if (theme.ok) appearance = theme.value.appearance
    if (info.ok) {
      noMotion = info.value.noMotion
      e2e = info.value.e2e
    }
  } catch {
    // fall back to system
  }
  initTheme(appearance)
  initMotion({ e2e, noMotion })
  return { resolved: themeStore.getState().resolved }
}
