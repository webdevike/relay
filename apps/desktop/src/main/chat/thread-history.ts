// An assistant's thread is one conversation across its contexts: the Relay Host starts a fresh omp
// session at each rollover (jobs/eva-rollover) or restart and keeps the ones before in the thread's
// record, `<relay>/assistants/<id>.json` (`history`, oldest first, and the live `sessionFile`). A
// chat pane on the live file shows the earlier contexts above it, as the phone does.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { parseSession, type ParsedSession } from '@evaos/chat-core/session'
import type { ChatMessage } from '@evaos/chat-core/message'

/**
 * Rows of earlier contexts a thread shows at most: whole contexts, newest first (a busy day is
 * 1,000 to 2,000 rows), so the pane opens and rereads fast. The newest earlier context always shows.
 */
export const EARLIER_ROWS = 5000

const ThreadRecord = z.object({
  history: z.array(z.string()).default([]),
  sessionFile: z.string().optional(),
})

interface Parsed {
  mtimeMs: number
  size: number
  messages: ChatMessage[]
}

function real(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

export class ThreadHistory {
  private readonly parsed = new Map<string, Parsed>()
  /** The last answer per live file, kept while its contexts are unchanged (rows compare by identity). */
  private readonly answers = new Map<
    string,
    { key: string; files: string[]; rows: ChatMessage[] }
  >()

  /** `relayDir`: the Relay Host's config dir (`~/.config/relay`), null when this Mac has none. */
  constructor(
    private readonly relayDir: string | null,
    private readonly maxRows = EARLIER_ROWS,
  ) {}

  /** `file` parsed, with its thread's earlier contexts first when it is an assistant's live session. */
  read(file: string): ParsedSession {
    const parsed = parseSession(fs.readFileSync(file, 'utf8'))
    const earlier = this.earlier(file)
    if (earlier.length === 0) return parsed
    // Ids are omp's entry ids, unique within a file: a clash across files keeps the live row.
    const live = new Set(parsed.messages.map((m) => m.id))
    const kept = earlier.some((m) => live.has(m.id))
      ? earlier.filter((m) => !live.has(m.id))
      : earlier
    return { ...parsed, messages: [...kept, ...parsed.messages] }
  }

  /** The earlier contexts' rows of the thread whose live session is `file`, oldest first; empty for any other file. */
  earlier(file: string): ChatMessage[] {
    const live = real(file)
    const threads = this.threads()
    // A thread that rolled over since leaves its old live file's answer behind.
    for (const shown of [...this.answers.keys()])
      if (!threads.has(shown)) this.answers.delete(shown)
    const history = threads.get(live)
    if (history === undefined) {
      this.evict()
      return []
    }
    const contexts: Array<{ file: string; parsed: Parsed }> = []
    // Every context read, the one past the budget too: kept parsed, so the next read stays cheap.
    const read: string[] = []
    let rows = 0
    for (const f of [...history].reverse()) {
      if (real(f) === live) continue
      const p = this.parse(f)
      if (p === null) continue
      read.push(f)
      if (contexts.length > 0 && rows + p.messages.length > this.maxRows) break
      contexts.unshift({ file: f, parsed: p })
      rows += p.messages.length
    }
    const key = contexts.map((c) => `${c.file}\0${c.parsed.mtimeMs}\0${c.parsed.size}`).join('\n')
    const cached = this.answers.get(live)
    if (cached?.key === key) {
      cached.files = read
      return cached.rows
    }
    const seen = new Set<string>()
    const out: ChatMessage[] = []
    for (const c of contexts)
      for (const m of c.parsed.messages) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
        out.push(m)
      }
    this.answers.set(live, { key, files: read, rows: out })
    this.evict()
    return out
  }

  /** Each assistant thread's earlier contexts (`history`, oldest first) by its live session's real path. */
  private threads(): Map<string, string[]> {
    const out = new Map<string, string[]>()
    if (this.relayDir === null) return out
    const dir = path.join(this.relayDir, 'assistants')
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return out
    }
    for (const name of names) {
      // `<id>.json` only: `<id>.asks.json` beside it holds the thread's open asks.
      if (!/^[a-z0-9][a-z0-9_-]*\.json$/.test(name)) continue
      let raw: unknown
      try {
        raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      } catch {
        continue
      }
      const r = ThreadRecord.safeParse(raw)
      if (r.success && r.data.sessionFile !== undefined)
        out.set(real(r.data.sessionFile), r.data.history)
    }
    return out
  }

  /** A context's rows, read again only when its file changed; null when it is gone or unreadable. */
  private parse(file: string): Parsed | null {
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      return null
    }
    const cached = this.parsed.get(file)
    if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached
    let messages: ChatMessage[]
    try {
      messages = parseSession(fs.readFileSync(file, 'utf8')).messages
    } catch {
      return null
    }
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, messages }
    this.parsed.set(file, entry)
    return entry
  }

  /** Forgets the rows of contexts no thread shows any more. */
  private evict(): void {
    const shown = new Set([...this.answers.values()].flatMap((a) => a.files))
    for (const f of [...this.parsed.keys()]) if (!shown.has(f)) this.parsed.delete(f)
  }
}
