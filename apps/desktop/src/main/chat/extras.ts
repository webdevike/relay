// Subagents and background jobs of each open chat, derived from session files (the Rust source of
// truth). Reuses the ChatWatch batches fed in by index.ts; this module never watches anything.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { backgroundJobs, subagentsFromListing } from '@evaos/chat-core/jobs'
import { oneLine } from '@evaos/chat-core/session'
import type { Subagent } from '@evaos/chat-core/message'
import type { Extras } from '@evaos/contract'
import type { SessionManager } from './session-manager'

export interface ExtrasOptions {
  manager: Pick<SessionManager, 'paneFiles'>
  emit: (e: Extras) => void
  readText?: (file: string) => string
  /** Direct entries of a folder (files only matter); throws or returns [] when absent. */
  readDir?: (dir: string) => Array<{ name: string; mtimeMs: number }>
}

const LAST_LINE_MAX = 160

function defaultReadDir(dir: string): Array<{ name: string; mtimeMs: number }> {
  const out: Array<{ name: string; mtimeMs: number }> = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // Only direct files: nested folders (a subagent's own subagents) are ignored (T-04-50).
    if (!e.isFile()) continue
    try {
      out.push({ name: e.name, mtimeMs: fs.statSync(path.join(dir, e.name)).mtimeMs })
    } catch {
      // vanished between listing and stat
    }
  }
  return out
}

/** The last assistant text of a subagent transcript, on one line ('' when it has none). */
export function lastAssistantLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    if (!line.includes('"assistant"')) continue
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const msg = (rec as { message?: { role?: unknown; content?: unknown } } | null)?.message
    if (!msg || msg.role !== 'assistant') continue
    const parts = Array.isArray(msg.content) ? (msg.content as unknown[]) : []
    const joined = parts
      .map((p) =>
        typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text'
          ? String((p as { text?: unknown }).text ?? '')
          : '',
      )
      .join(' ')
    const one = oneLine(joined, LAST_LINE_MAX)
    if (one !== '') return one
  }
  return ''
}

export class ExtrasService {
  private readonly readText: (f: string) => string
  private readonly readDir: (d: string) => Array<{ name: string; mtimeMs: number }>
  /** What the renderer last heard per pane, as JSON, so an unchanged result emits nothing. */
  private readonly last = new Map<string, string>()

  constructor(private readonly o: ExtrasOptions) {
    this.readText = o.readText ?? ((f) => fs.readFileSync(f, 'utf8'))
    this.readDir = o.readDir ?? defaultReadDir
  }

  /** A pane was opened on a (new) file: the next refresh emits even when nothing differs. */
  reset(paneId: string): void {
    this.last.delete(paneId)
  }

  refresh(paneId?: string): void {
    for (const p of this.o.manager.paneFiles()) {
      if (paneId !== undefined && p.paneId !== paneId) continue
      this.compute(p)
    }
  }

  onFilesChanged(files: string[]): void {
    const names = new Set(files.map((f) => path.basename(f)))
    for (const p of this.o.manager.paneFiles()) {
      const base = path.basename(p.file)
      if (names.has(base) || names.has(base.replace(/\.jsonl$/, ''))) this.compute(p)
    }
  }

  private compute(p: { paneId: string; file: string; live: boolean }): void {
    let jobs: Extras['jobs'] = []
    if (p.live) {
      try {
        jobs = backgroundJobs(this.readText(p.file))
      } catch {
        jobs = []
      }
    }
    const e: Extras = {
      paneId: p.paneId,
      running: p.live,
      subagents: this.subagents(p.file),
      jobs,
    }
    const key = JSON.stringify(e)
    if (this.last.get(p.paneId) === key) return
    this.last.set(p.paneId, key)
    this.o.emit(e)
  }

  private subagents(file: string): Subagent[] {
    const dir = file.replace(/\.jsonl$/, '')
    if (dir === file) return []
    let entries: Array<{ name: string; mtimeMs: number }>
    try {
      entries = this.readDir(dir)
    } catch {
      return []
    }
    return subagentsFromListing(entries).map((s) => {
      let lastLine = ''
      try {
        lastLine = lastAssistantLine(this.readText(path.join(dir, s.file)))
      } catch {
        lastLine = ''
      }
      return {
        name: s.name,
        file: s.file,
        done: s.done,
        failed: false,
        mtimeMs: s.mtimeMs,
        lastLine,
      }
    })
  }
}
