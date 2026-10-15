import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ChatList, ChatPrefs, ChatRow } from '@evaos/contract'
import { isRecentlyActive } from '@evaos/chat-core/chat-groups'
import { sessionId } from '@evaos/chat-core/session-id'
import { backgroundJobs } from '@evaos/chat-core/jobs'
import { oneLine, parseSession } from '@evaos/chat-core/session'
import { rowStatus } from '@evaos/chat-core/status'
import type { ConfigStore } from '../config-store'

export const LIST_ERROR =
  'Could not read your chats. Check that the sessions folder exists, then reload.'

const CHUNK = 64 * 1024
const TITLE_MAX = 80

export interface ChatListDeps {
  sessionsDir: string
  agentDir: string
  config: ConfigStore
  now?: () => number
  /** Session files this app owns a live process for. */
  liveFiles?: () => ReadonlySet<string>
  /** Live state of a session file this app owns, else null. */
  liveStatus?: (file: string) => { working: boolean; dialog: 'confirm' | 'other' | null } | null
  /** Test seam: how a changed file is read. */
  readFile?: (file: string) => FileSample
}

export interface FileSample {
  /** Up to 64 KB from the start. */
  head: string
  /** Up to 64 KB from the end (the whole file when it is smaller). */
  tail: string
  /** Full text, read lazily and only when no title record exists. */
  full: () => string
}

interface Entry {
  mtimeMs: number
  size: number
  title: string
  jobs: number
}

/** Files past this size skip the background-job scan (the status stays as without jobs). */
const JOBS_SCAN_MAX = 8 * 1024 * 1024

function sampleFile(file: string, size: number): FileSample {
  const fd = fs.openSync(file, 'r')
  try {
    const read = (len: number, pos: number): string => {
      const buf = Buffer.alloc(len)
      const n = fs.readSync(fd, buf, 0, len, pos)
      return buf.toString('utf8', 0, n)
    }
    const head = read(Math.min(CHUNK, size), 0)
    const tail = size <= CHUNK ? head : read(CHUNK, size - CHUNK)
    let whole: string | null = null
    return {
      head,
      tail,
      full: () => (whole ??= fs.readFileSync(file, 'utf8')),
    }
  } finally {
    fs.closeSync(fd)
  }
}

function titleOf(rec: unknown): string | null {
  if (typeof rec !== 'object' || rec === null) return null
  const r = rec as Record<string, unknown>
  return typeof r.title === 'string' && r.title !== '' ? r.title : null
}

function parseLines(text: string, dropFirst: boolean): unknown[] {
  const lines = text.split('\n')
  if (dropFirst) lines.shift()
  const out: unknown[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // partial or malformed line
    }
  }
  return out
}

/** Rename appends a title record, so the last one in the file wins over the header. */
function resolveTitle(sample: FileSample, size: number): string {
  const wholeFile = size <= CHUNK
  const head = parseLines(sample.head, false)
  let title: string | null = null
  for (const rec of head.slice(0, 4)) {
    const r = rec as Record<string, unknown> | null
    if (r && (r.type === 'title' || r.type === 'session')) {
      const t = titleOf(r)
      if (t !== null && (title === null || r.type === 'title')) title = t
    }
  }
  const tail = wholeFile ? head : parseLines(sample.tail, true)
  for (const rec of tail) {
    const r = rec as Record<string, unknown> | null
    if (r && r.type === 'title') {
      const t = titleOf(r)
      if (t !== null) title = t
    }
  }
  if (title !== null) return title

  try {
    const parsed = parseSession(sample.full())
    const first = parsed.messages.find((m) => m.role === 'user')
    if (first) {
      const line = oneLine(first.text, TITLE_MAX)
      if (line !== '') return line
      if (first.images.length > 0) return 'Image'
    }
  } catch {
    // unreadable: untitled
  }
  return ''
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** Every omp session as list rows: cached by mtime and size, so a repeat scan reads nothing. */
export class ChatListService {
  private cache = new Map<string, Entry>()
  private readonly now: () => number
  private readonly liveFiles: () => ReadonlySet<string>
  private readonly readFile: (file: string, size: number) => FileSample

  constructor(private readonly deps: ChatListDeps) {
    this.now = deps.now ?? Date.now
    this.liveFiles = deps.liveFiles ?? (() => new Set())
    this.readFile = deps.readFile ? (f) => deps.readFile!(f) : sampleFile
  }

  invalidate(file?: string): void {
    if (file === undefined) this.cache.clear()
    else this.cache.delete(file)
  }

  private prefs(): { prefs: ChatPrefs; archived: Set<string> } {
    const raw = this.deps.config.readJson<unknown>('chat.json', {})
    const src = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    const assignedRaw = src.chat_assignments
    const chat_assignments: Record<string, string> = {}
    if (typeof assignedRaw === 'object' && assignedRaw !== null && !Array.isArray(assignedRaw)) {
      for (const [id, name] of Object.entries(assignedRaw)) {
        if (typeof name === 'string') chat_assignments[id] = name
      }
    }
    return {
      prefs: {
        chat_categories: strings(src.chat_categories),
        chat_group_order: strings(src.chat_group_order),
        chat_assignments,
        collapsed_groups: strings(src.collapsed_groups),
      },
      archived: new Set(strings(src.archived_chats)),
    }
  }

  private pins(): Set<string> {
    try {
      const v: unknown = JSON.parse(
        fs.readFileSync(path.join(this.deps.agentDir, 'session-pins.json'), 'utf8'),
      )
      return new Set(strings(v))
    } catch {
      return new Set()
    }
  }

  list(): ChatList {
    const { prefs, archived } = this.prefs()
    let names: string[]
    try {
      names = fs.readdirSync(this.deps.sessionsDir)
    } catch {
      return { rows: [], prefs, error: LIST_ERROR }
    }
    const pins = this.pins()
    const live = this.liveFiles()
    const now = this.now()
    const seen = new Set<string>()
    const rows: ChatRow[] = []
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const file = path.join(this.deps.sessionsDir, name)
      let st: fs.Stats
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      seen.add(file)
      let entry = this.cache.get(file)
      if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
        let title = ''
        let jobs = 0
        try {
          const sample = this.readFile(file, st.size)
          title = resolveTitle(sample, st.size)
          if (st.size <= JOBS_SCAN_MAX) jobs = backgroundJobs(sample.full()).length
        } catch {
          // unreadable file: listed untitled
        }
        entry = { mtimeMs: st.mtimeMs, size: st.size, title, jobs }
        this.cache.set(file, entry)
      }
      const id = sessionId(file)
      const owned = this.deps.liveStatus?.(file) ?? null
      rows.push({
        id,
        file,
        title: entry.title || id,
        mtimeMs: st.mtimeMs,
        archived: archived.has(id),
        pinned: pins.has(id),
        running: live.has(file) || owned !== null || isRecentlyActive(st.mtimeMs, now),
        status: rowStatus({
          owned: owned !== null,
          working: owned?.working ?? false,
          dialog: owned?.dialog ?? null,
          jobs: entry.jobs,
        }),
      })
    }
    for (const file of this.cache.keys()) if (!seen.has(file)) this.cache.delete(file)
    rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file))
    return { rows, prefs, error: null }
  }
}
