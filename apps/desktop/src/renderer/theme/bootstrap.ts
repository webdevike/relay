import { invoke } from '../ipc'
import { initMotion } from './motion'
import { parseSavedTheme, persistTheme, seedTheme } from './theme-config'

/** Seeds the saved preset config before first render (Texo reads it from storage the same way). */
export async function bootstrapTheme(): Promise<void> {
  let saved: unknown = null
  let noMotion = false
  let e2e = false
  try {
    const [theme, info] = await Promise.all([invoke('theme.load', {}), invoke('app.info', {})])
    if (theme.ok) saved = theme.value.theme
    if (info.ok) {
      noMotion = info.value.noMotion
      e2e = info.value.e2e
    }
  } catch {
    // fall back to the Default preset
  }
  seedTheme(parseSavedTheme(saved))
  persistTheme()
  initMotion({ e2e, noMotion })
}
