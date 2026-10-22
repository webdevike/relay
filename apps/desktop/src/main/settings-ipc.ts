import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ConfigStore } from './config-store'
import type { MainContext } from './context'
import { handle } from './ipc/handle'
import type { WriteQueue } from './write-queue'

/** Where the Rust app keeps these keys. */
const CHAT_FILE = 'chat.json'
/** Older EvaOS Electron builds wrote here; still read as a fallback, never written. */
const LEGACY_FILE = 'settings.json'

export interface ChatSettings {
  show_thinking: boolean
  show_tools: boolean
  harness: 'omp' | 'claude'
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function readFile(config: ConfigStore, name: string): Record<string, unknown> {
  const v = config.readJson<unknown>(name, {})
  return isRecord(v) ? v : {}
}

function pickBool(key: string, files: Record<string, unknown>[], dflt: boolean): boolean {
  for (const f of files) if (typeof f[key] === 'boolean') return f[key]
  return dflt
}

export function loadSettings(config: ConfigStore): ChatSettings {
  const files = [readFile(config, CHAT_FILE), readFile(config, LEGACY_FILE)]
  let harness: ChatSettings['harness'] = 'omp'
  for (const f of files) {
    if (f['harness'] === 'omp' || f['harness'] === 'claude') {
      harness = f['harness']
      break
    }
  }
  return {
    show_thinking: pickBool('show_thinking', files, false),
    show_tools: pickBool('show_tools', files, false),
    harness,
  }
}

/** One read-modify-write of chat.json: only the patched keys change, unknown keys survive. */
export function saveSettings(config: ConfigStore, patch: Partial<ChatSettings>): ChatSettings {
  const existing = config.readForMerge(CHAT_FILE)
  config.writeJson(CHAT_FILE, { ...existing, ...patch })
  return loadSettings(config)
}

function exists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

export function registerSettingsIpc(ctx: MainContext, queue: WriteQueue): void {
  handle(ctx, 'settings.load', () => loadSettings(ctx.config))
  handle(ctx, 'settings.save', (patch) => queue.enqueue(() => saveSettings(ctx.config, patch)))
  handle(ctx, 'chat.harnessStatus', () => ({
    // A bare command name resolves through PATH at spawn time.
    omp: path.isAbsolute(ctx.env.ompBin) ? exists(ctx.env.ompBin) : true,
    claude: exists(ctx.env.claudeBin) && exists(ctx.env.claudeBridgeBin),
  }))
}
