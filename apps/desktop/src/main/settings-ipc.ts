import type { ConfigStore } from './config-store'
import type { MainContext } from './context'
import { handle } from './ipc/handle'
import type { WriteQueue } from './write-queue'

const FILE = 'settings.json'

export interface ChatSettings {
  show_thinking: boolean
  show_tools: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function readFile(config: ConfigStore): Record<string, unknown> {
  const v = config.readJson<unknown>(FILE, {})
  return isRecord(v) ? v : {}
}

export function loadSettings(config: ConfigStore): ChatSettings {
  const f = readFile(config)
  return {
    show_thinking: typeof f['show_thinking'] === 'boolean' ? f['show_thinking'] : true,
    show_tools: typeof f['show_tools'] === 'boolean' ? f['show_tools'] : true,
  }
}

export function saveSettings(config: ConfigStore, patch: Partial<ChatSettings>): ChatSettings {
  const merged = { ...loadSettings(config), ...patch }
  config.writeJson(FILE, { ...readFile(config), ...merged })
  return merged
}

export function registerSettingsIpc(ctx: MainContext, queue: WriteQueue): void {
  handle(ctx, 'settings.load', () => loadSettings(ctx.config))
  handle(ctx, 'settings.save', (patch) => queue.enqueue(() => saveSettings(ctx.config, patch)))
}
