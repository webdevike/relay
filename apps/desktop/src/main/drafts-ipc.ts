import { app } from 'electron'
import { MAX_COMPOSER_DRAFTS, type ComposerDraft } from '@evaos/contract'
import type { ConfigStore } from './config-store'
import type { MainContext } from './context'
import { handle } from './ipc/handle'

export const DRAFTS_FILE = 'drafts.json'
/** A save reaches disk at most this long after the first unsaved change. */
export const DRAFTS_SAVE_MS = 300

interface Entry {
  text: string
  /** Last change, ms since the epoch: the newest MAX_COMPOSER_DRAFTS are kept. */
  at: number
}

export interface Drafts {
  /** Newest first. */
  list(): ComposerDraft[]
  /** Empty text forgets the key. */
  save(key: string, text: string): void
  /** Writes a pending change now (quit). */
  flush(): void
}

function readEntries(config: ConfigStore): Map<string, Entry> {
  const raw = config.readJson<unknown>(DRAFTS_FILE, null)
  const out = new Map<string, Entry>()
  if (typeof raw !== 'object' || raw === null || !('drafts' in raw)) return out
  const { drafts } = raw
  if (typeof drafts !== 'object' || drafts === null) return out
  for (const [key, v] of Object.entries(drafts)) {
    if (key === '' || typeof v !== 'object' || v === null) continue
    const text: unknown = 'text' in v ? v.text : undefined
    const at: unknown = 'at' in v ? v.at : undefined
    if (typeof text === 'string' && text !== '' && typeof at === 'number' && Number.isFinite(at)) {
      out.set(key, { text, at })
    }
  }
  return out
}

/**
 * Composer drafts per chat key (session file, or `draft:<tab id>` for an unsent chat), so they
 * survive a restart. Held in memory; the file follows within DRAFTS_SAVE_MS, and on flush.
 */
export function createDrafts(config: ConfigStore, now: () => number = Date.now): Drafts {
  const entries = readEntries(config)
  let timer: NodeJS.Timeout | null = null
  let dirty = false
  /** Strictly increasing stamps, so the newest-first order never ties. */
  let last = Math.max(0, ...[...entries.values()].map((e) => e.at))

  const newest = (): Array<[string, Entry]> => [...entries].sort((a, b) => b[1].at - a[1].at)

  const write = (): void => {
    clearTimeout(timer ?? undefined)
    timer = null
    if (!dirty) return
    dirty = false
    try {
      config.writeJson(DRAFTS_FILE, { version: 1, drafts: Object.fromEntries(newest()) })
    } catch (e) {
      console.warn('[drafts] saving failed:', e instanceof Error ? e.message : e)
    }
  }

  return {
    list: () => newest().map(([key, e]) => ({ key, text: e.text })),
    save(key, text) {
      const had = entries.get(key)
      if (text === '') {
        if (!had) return
        entries.delete(key)
      } else {
        if (had?.text === text) return
        last = Math.max(now(), last + 1)
        entries.set(key, { text, at: last })
        for (const [old] of newest().slice(MAX_COMPOSER_DRAFTS)) entries.delete(old)
      }
      dirty = true
      timer ??= setTimeout(write, DRAFTS_SAVE_MS)
    },
    flush: write,
  }
}

export function registerDraftsIpc(ctx: MainContext): Drafts {
  const drafts = createDrafts(ctx.config)
  handle(ctx, 'drafts.load', () => ({ drafts: drafts.list() }))
  handle(ctx, 'drafts.save', ({ key, text }) => {
    drafts.save(key, text)
    return {}
  })
  // A quit by signal (the supervisor's SIGTERM) runs before-quit too.
  app.on('before-quit', drafts.flush)
  return drafts
}
