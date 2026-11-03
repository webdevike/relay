// Who is working for a chat or an assistant, from files only: a session's subagent transcripts
// (`<session>/<Name>.jsonl`, done once omp wrote `<Name>.md`) and an assistant's own record of the
// sessions it started (`work/eva/agents/<id>/sessions.json`, Astra's `auto-work.json`).
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { SUBAGENT_STALE_MS } from '@evaos/chat-core/artifacts'
import { subagentsFromListing } from '@evaos/chat-core/jobs'
import { readTail } from '../assistants/assistants'
import { lastAssistantLine } from '../chat/extras'

/** A session file written this recently is still working. */
export const ACTIVE_MS = 10 * 60_000

export interface Worker {
  name: string
  /** Its transcript, absolute. */
  file: string
  /** The session it belongs to (subagents), else its own file. */
  session: string
  running: boolean
  /** Running: when it started (best known); done: when it finished. */
  at: number
  /** Its last words, one line ('' when none). */
  line: string
  /**
   * A session an assistant started (its sessions.json): true once its job closed it (`closedAt`),
   * false while open. Absent on subagents.
   */
  closed?: boolean
}

const TAIL = 64 * 1024

/** Reads a transcript's last line only when the file changed. */
export class LineCache {
  private readonly seen = new Map<string, { mtimeMs: number; size: number; line: string }>()

  line(file: string, st: fs.Stats): string {
    const hit = this.seen.get(file)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.line
    const tail = readTail(file, TAIL)
    const line = tail === null ? '' : lastAssistantLine(tail)
    this.seen.set(file, { mtimeMs: st.mtimeMs, size: st.size, line })
    if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value!)
    return line
  }
}

function stat(file: string): fs.Stats | null {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

/**
 * The subagents of session `file`, newest first: running ones (no `.md` yet, written in the last
 * SUBAGENT_STALE_MS) and finished ones (by their `.md` time). Abandoned transcripts are left out.
 */
export function subagentsOf(file: string, now: number, lines: LineCache): Worker[] {
  const dir = file.replace(/\.jsonl$/, '')
  if (dir === file) return []
  let names: fs.Dirent[]
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const entries: Array<{ name: string; mtimeMs: number }> = []
  const mds = new Map<string, number>()
  for (const d of names) {
    if (!d.isFile()) continue
    const st = stat(path.join(dir, d.name))
    if (!st) continue
    entries.push({ name: d.name, mtimeMs: st.mtimeMs })
    if (d.name.endsWith('.md')) mds.set(d.name, st.mtimeMs)
  }
  const out: Worker[] = []
  for (const s of subagentsFromListing(entries)) {
    if (!s.done && now - s.mtimeMs > SUBAGENT_STALE_MS) continue
    const full = path.join(dir, s.file)
    const st = stat(full)
    if (!st) continue
    out.push({
      name: s.name,
      file: full,
      session: file,
      running: !s.done,
      at: s.done ? (mds.get(`${s.name}.md`) ?? s.mtimeMs) : st.birthtimeMs || s.mtimeMs,
      line: lines.line(full, st),
    })
  }
  return out
}

const SessionsJson = z.array(
  z.object({
    id: z.string().optional(),
    sessionFile: z.string().startsWith('/'),
    title: z.string().optional(),
    startedAt: z.string().optional(),
    closedAt: z.string().nullish(),
  }),
)
const AutoWorkJson = z.object({
  started: z
    .record(
      z.string(),
      z.object({
        state: z.string().optional(),
        phase: z.string().optional(),
        sessionFile: z.string().optional(),
      }),
    )
    .optional(),
})

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * The sessions assistant `agent` started (its sessions.json), as workers: running while the file
 * was written in the last ACTIVE_MS (or auto-work.json says running), else done at its last write.
 * Every open one is listed; of the ones its job closed, only the newest `limit`.
 */
export function assistantSessions(
  evaRoot: string,
  agent: string,
  now: number,
  lines: LineCache,
  limit = 12,
): Worker[] {
  const dir = path.join(evaRoot, 'work/eva/agents', agent)
  const list = SessionsJson.safeParse(readJson(path.join(dir, 'sessions.json')))
  if (!list.success) return []
  const auto = AutoWorkJson.safeParse(readJson(path.join(dir, 'auto-work.json')))
  const autoState = new Map<string, { state?: string; phase?: string }>()
  if (auto.success) {
    for (const s of Object.values(auto.data.started ?? {})) {
      if (s.sessionFile) autoState.set(s.sessionFile, s)
    }
  }
  const out: Worker[] = []
  const seen = new Set<string>()
  let closedLeft = limit
  for (const s of list.data.slice().reverse()) {
    if (seen.has(s.sessionFile)) continue
    seen.add(s.sessionFile)
    const closed = Boolean(s.closedAt)
    if (closed && closedLeft-- <= 0) continue
    const st = stat(s.sessionFile)
    if (!st) continue
    const a = autoState.get(s.sessionFile)
    const running =
      a?.state === 'running' || (a?.state === undefined && now - st.mtimeMs < ACTIVE_MS)
    const started = s.startedAt ? Date.parse(s.startedAt) : NaN
    out.push({
      name: s.title || s.id || path.basename(s.sessionFile, '.jsonl'),
      file: s.sessionFile,
      session: s.sessionFile,
      running,
      at: running ? (Number.isNaN(started) ? st.birthtimeMs : started) : st.mtimeMs,
      line: a?.phase && running ? a.phase : lines.line(s.sessionFile, st),
      closed,
    })
  }
  return out
}

const HostThread = z.object({ sessionFile: z.string().startsWith('/').endsWith('.jsonl') })

/** The thread Relay's host keeps for assistant `agent` (`<relay>/assistants/<id>.json`), if it still exists. */
export function hostThreadFile(relayDir: string, agent: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(agent)) return null
  const r = HostThread.safeParse(readJson(path.join(relayDir, 'assistants', `${agent}.json`)))
  return r.success && fs.existsSync(r.data.sessionFile) ? r.data.sessionFile : null
}

const HEAD_BYTES = 16 * 1024

/** A session's title from the records at its head (`title`, then `session`), or null. */
export function sessionTitle(file: string): string | null {
  let head: string
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(HEAD_BYTES)
      head = buf.subarray(0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0)).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  for (const line of head.split('\n')) {
    if (!line.includes('"title"')) continue
    try {
      const r = JSON.parse(line) as { type?: unknown; title?: unknown }
      if ((r.type === 'title' || r.type === 'session') && typeof r.title === 'string' && r.title) {
        return r.title
      }
    } catch {
      // A line cut at HEAD_BYTES.
    }
  }
  return null
}

/**
 * Text an assistant keeps about its work (thread memory, follow-ups, session titles): the work
 * items it names are its own.
 */
export function assistantNotes(evaRoot: string, agent: string): string {
  const dir = path.join(evaRoot, 'work/eva/agents', agent)
  const parts: string[] = []
  for (const name of ['thread.md', 'followups.json', 'sessions.json', 'auto-work.json']) {
    try {
      parts.push(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      // Not every assistant keeps every file.
    }
  }
  return parts.join('\n')
}
