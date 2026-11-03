import { app } from 'electron'
import { z } from 'zod'
import { SavedThemeSchema, type SavedTheme } from '@evaos/contract'
import type { ConfigStore } from './config-store'
import type { MainContext } from './context'
import { handle } from './ipc/handle'
import type { WriteQueue } from './write-queue'

// theme.json: { config, preset } from the renderer's Texo-style theme, plus app.lastBackground.
const FILE = 'theme.json'
export const DEFAULT_BACKGROUND = '#181817'

const AppStateSchema = z.object({ lastBackground: z.unknown().optional() }).passthrough()
const ThemeFileSchema = z.object({ app: AppStateSchema.optional() }).passthrough()
type ThemeFile = z.infer<typeof ThemeFileSchema>

/** A file whose app key is not an object loses only that key, never the rest. */
function readFile(raw: unknown): ThemeFile {
  const parsed = ThemeFileSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const whole = z.object({}).passthrough().safeParse(raw)
  return whole.success ? { ...whole.data, app: undefined } : {}
}

/** The saved preset config, or null when the file holds none (first run, or an older theme format). */
export function loadTheme(config: ConfigStore): { theme: SavedTheme | null } {
  const parsed = SavedThemeSchema.safeParse(config.readJson<unknown>(FILE, {}))
  return { theme: parsed.success ? parsed.data : null }
}

/** Replaces the theme and keeps only app state beside it, so an older format does not linger. */
export function saveTheme(config: ConfigStore, theme: SavedTheme): void {
  const { app: appState } = readFile(config.readForMerge(FILE))
  config.writeJson(FILE, { ...(appState ? { app: appState } : {}), ...theme })
}

export function saveLastBackground(config: ConfigStore, color: string): void {
  const doc = readFile(config.readForMerge(FILE))
  config.writeJson(FILE, { ...doc, app: { ...doc.app, lastBackground: color } })
}

export function readLastBackground(config: ConfigStore): string {
  const color = readFile(config.readJson<unknown>(FILE, {})).app?.lastBackground
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_BACKGROUND
}

export function registerThemeIpc(ctx: MainContext, queue: WriteQueue): void {
  handle(ctx, 'theme.load', () => loadTheme(ctx.config))
  handle(ctx, 'theme.save', async (theme) => {
    await queue.enqueue(() => saveTheme(ctx.config, theme))
    return {}
  })
  handle(ctx, 'app.setBackground', async ({ color }) => {
    if (!ctx.win.isDestroyed()) ctx.win.setBackgroundColor(color)
    if (!ctx.shell.webContents.isDestroyed()) ctx.shell.setBackgroundColor(color)
    await queue.enqueue(() => saveLastBackground(ctx.config, color))
    return {}
  })
  handle(ctx, 'app.quit', () => {
    // After the reply is delivered. The quit guard intercepts before-quit.
    setImmediate(() => app.quit())
    return {}
  })
}
