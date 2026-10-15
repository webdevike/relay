import { app } from 'electron'
import { parseThemeDoc } from '@evaos/theme-core'
import type { ConfigStore } from './config-store'
import type { MainContext } from './context'
import { handle } from './ipc/handle'
import type { WriteQueue } from './write-queue'

const FILE = 'theme.json'
export const DEFAULT_BACKGROUND = '#181817'

type Appearance = 'light' | 'dark' | 'system'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function readDoc(config: ConfigStore): Record<string, unknown> {
  const v = config.readJson<unknown>(FILE, {})
  return isRecord(v) ? v : {}
}

function patchApp(config: ConfigStore, key: string, value: unknown): void {
  const doc = readDoc(config)
  const prevApp = isRecord(doc['app']) ? doc['app'] : {}
  config.writeJson(FILE, { ...doc, app: { ...prevApp, [key]: value } })
}

export function loadAppearance(config: ConfigStore): Appearance {
  return parseThemeDoc(readDoc(config)).app.appearance
}

export function saveAppearance(config: ConfigStore, appearance: Appearance): void {
  patchApp(config, 'appearance', appearance)
}

export function saveLastBackground(config: ConfigStore, color: string): void {
  patchApp(config, 'lastBackground', color)
}

export function readLastBackground(config: ConfigStore): string {
  const doc = readDoc(config)
  const a = isRecord(doc['app']) ? doc['app']['lastBackground'] : undefined
  return typeof a === 'string' && /^#[0-9a-fA-F]{6}$/.test(a) ? a : DEFAULT_BACKGROUND
}

export function registerThemeIpc(ctx: MainContext, queue: WriteQueue): void {
  handle(ctx, 'theme.load', () => ({ appearance: loadAppearance(ctx.config) }))
  handle(ctx, 'theme.setAppearance', async ({ appearance }) => {
    await queue.enqueue(() => saveAppearance(ctx.config, appearance))
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
