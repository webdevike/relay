// Subagents and background jobs of each open chat, derived from session files (the Rust source of
// truth). Reuses the ChatWatch batches fed in by index.ts; this module never watches anything.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { backgroundJobs, subagentOver, subagentsFromListing } from '@evaos/chat-core/jobs'
import { oneLine } from '@evaos/chat-core/session'
import type { Subagent } from '@evaos/chat-core/message'
import { z } from 'zod'
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

/** Fields a structured (JSON object) result most likely summarizes itself in, best first. */
const SUMMARY_KEYS = [
  'summary',
  'outcome',
  'result',
  'message',
  'answer',
  'description',
  'status',
  'title',
]

/**
 * A finished subagent's outcome: the first line of its result `.md` (omp writes the summary as a
 * JSON string, so a quoted body is decoded first). A structured result (a JSON object or array, as
 * a subagent with an output schema leaves) shows its summary-like string field, or nothing: its
 * first line is just `{`, never a label. '' when it is empty, unreadable or has no prose.
 */
export function outcomeLine(md: string): string {
  let body = md.trim()
  if (body.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed === 'string') body = parsed.trim()
    } catch {
      // not a JSON string: read it as plain text
    }
  }
  if (body.startsWith('{') || body.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      // A truncated object has no label to offer; `[text](link) ...` is prose, read below.
      if (body.startsWith('{')) return ''
    }
    if (parsed !== undefined) {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
      const rec = parsed as Record<string, unknown>
      for (const key of SUMMARY_KEYS) {
        const v = rec[key]
        if (typeof v === 'string' && /[\p{L}\p{N}]/u.test(v)) return oneLine(v, LAST_LINE_MAX)
      }
      return ''
    }
  }
  // First line with a letter or digit, so a stray `{`, `---` or fence never becomes the label.
  const first = body.split('\n').find((l) => /[\p{L}\p{N}]/u.test(l)) ?? ''
  return oneLine(first.replace(/^#+\s*/, '').replace(/\*\*/g, ''), LAST_LINE_MAX)
}

// What `runningTool` reads of a transcript record; anything else in it is ignored.
const ToolCallSchema = z.object({ type: z.literal('toolCall'), id: z.string(), name: z.string() })
const RecordSchema = z.object({
  message: z.object({
    role: z.string(),
    toolCallId: z.string().optional().catch(undefined),
    content: z.array(z.unknown()).optional().catch(undefined),
  }),
})

/**
 * The tool a transcript is running now: its newest assistant message's last call still without a
 * result, read from the end; null when that message's calls all returned or a prompt came after.
 */
export function runningTool(text: string): string | null {
  const lines = text.split('\n')
  const answered = new Set<string>()
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    if (!line.includes('"message"')) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      continue
    }
    const r = RecordSchema.safeParse(raw)
    if (!r.success) continue
    const msg = r.data.message
    if (msg.role === 'user') return null
    if (msg.role === 'toolResult' && msg.toolCallId !== undefined) {
      answered.add(msg.toolCallId)
      continue
    }
    if (msg.role !== 'assistant') continue
    const calls = (msg.content ?? []).flatMap((p) => {
      const c = ToolCallSchema.safeParse(p)
      return c.success ? [c.data] : []
    })
    if (calls.length === 0) continue
    return calls.findLast((c) => !answered.has(c.id))?.name ?? null
  }
  return null
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
      const read = (f: string): string => {
        try {
          return this.readText(path.join(dir, f))
        } catch {
          return ''
        }
      }
      const text = read(s.file)
      // A helper woken by a follow-up message has an old `.md` and a transcript that goes on: running.
      const done = subagentOver(s, text)
      // A finished one shows its outcome (its `.md`), not the progress note it ended on.
      const outcome = done && s.done ? outcomeLine(read(`${s.name}.md`)) : ''
      return {
        name: s.name,
        file: s.file,
        done,
        failed: false,
        mtimeMs: s.mtimeMs,
        lastLine: outcome !== '' ? outcome : lastAssistantLine(text),
        tool: done ? null : runningTool(text),
      }
    })
  }
}
