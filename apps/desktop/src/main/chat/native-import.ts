// One-time seed of the chat list's history from the native EvaOS app, so a fresh Electron config
// does not show every chat as unread and unsettled. Read-only on the native files; Electron
// state that already exists is never overwritten.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CHAT_AGENTS } from '@evaos/chat-core/agent'
import type { ConfigStore } from '../config-store'
import { ORDER_FILE } from './chat-order'

const CHAT_FILE = 'chat.json'
/** The chat-order.json keys Electron reads (native `collapsed` is not one: collapse lives in chat.json). */
const ORDER_KEYS = ['returned', 'opened', 'kept', 'snoozed', 'woke'] as const

/** The native app's config folder: `$EVAOS_NATIVE_CONFIG_DIR`, else `~/Library/Application Support/EvaOS`. */
export function nativeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.EVAOS_NATIVE_CONFIG_DIR || path.join(os.homedir(), 'Library/Application Support/EvaOS')
}

function readObject(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Seeds Electron's chat-order.json from the native one when Electron has none yet, and chat.json
 * `archived_chats` (and `chat_agent`) from the native chat.json when Electron's lacks those keys.
 * Returns what it seeded.
 */
export function importNativeChatState(
  config: ConfigStore,
  nativeDir: string,
): { order: boolean; archived: boolean; agent: boolean } {
  const out = { order: false, archived: false, agent: false }
  if (config.readText(ORDER_FILE) === null) {
    const native = readObject(path.join(nativeDir, ORDER_FILE))
    if (native) {
      const doc: Record<string, unknown> = {}
      for (const key of ORDER_KEYS) if (key in native) doc[key] = native[key]
      config.writeJson(ORDER_FILE, doc)
      out.order = true
    }
  }
  const native = readObject(path.join(nativeDir, CHAT_FILE))
  if (!native) return out
  const existing = config.readForMerge(CHAT_FILE)
  const next = { ...existing }
  if (!('archived_chats' in existing) && Array.isArray(native.archived_chats)) {
    next.archived_chats = native.archived_chats.filter((x): x is string => typeof x === 'string')
    out.archived = true
  }
  const name = typeof native.chat_agent === 'string' ? native.chat_agent.toLowerCase() : null
  const agent = CHAT_AGENTS.find((a) => a.toLowerCase() === name)
  if (!('chat_agent' in existing) && agent !== undefined) {
    next.chat_agent = agent
    out.agent = true
  }
  if (out.archived || out.agent) config.writeJson(CHAT_FILE, next)
  return out
}
