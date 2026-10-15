import { app } from 'electron'
import { hasThemeFamily, parseThemeDoc, serializeThemeDoc, validateThemeDoc, THEME_CATALOG } from '@evaos/theme-core'
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
  const doc = config.readForMerge(FILE)
  const prevApp = isRecord(doc['app']) ? doc['app'] : {}
  config.writeJson(FILE, { ...doc, app: { ...prevApp, [key]: value } })
}

export function loadAppearance(config: ConfigStore): Appearance {
  return parseThemeDoc(readDoc(config)).app.appearance
}

export function loadTheme(config: ConfigStore): { appearance: Appearance; doc: Record<string, unknown> } {
  const doc = readDoc(config)
  return { appearance: parseThemeDoc(doc).app.appearance, doc }
}

export function saveBase(config: ConfigStore, base: string): void {
  if (!hasThemeFamily(base)) {
    throw Object.assign(new Error(`Unknown theme family: ${base}`), { code: 'unknown-theme' })
  }
  const doc = config.readForMerge(FILE)
  config.writeJson(FILE, { ...doc, base })
}

export function saveThemeDoc(config: ConfigStore, value: unknown): void {
  const doc = validateThemeDoc(value)
  const previous = config.readForMerge(FILE)
  const merged = serializeThemeDoc(doc, previous)
  validateThemeDoc(merged)
  config.writeJson(FILE, merged)
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
  handle(ctx, 'theme.load', () => loadTheme(ctx.config))
  handle(ctx, 'theme.list', () => ({ themes: [...THEME_CATALOG] }))
  handle(ctx, 'theme.setBase', async ({ base }) => {
    await queue.enqueue(() => saveBase(ctx.config, base))
    return {}
  })
  handle(ctx, 'theme.saveDoc', async ({ doc }) => {
    await queue.enqueue(() => saveThemeDoc(ctx.config, doc))
    return {}
  })
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
