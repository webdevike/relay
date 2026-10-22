// What the chat list needs from one omp session file, kept up to date by scanning only the bytes
// appended since the last look (sessions are append-only), like the native look::Cache. Lines are
// filtered by cheap substring checks before any JSON parse, so a first scan of a few hundred
// sessions stays fast.
import * as fs from 'node:fs'
import type { ChatAgent } from '@evaos/contract'
import { agentOfLine, CLASSIFY_BYTES } from '@evaos/chat-core/agent'
import { applyJobRecord, type BgJob } from '@evaos/chat-core/jobs'
import { oneLine, promptText } from '@evaos/chat-core/session'
import { workspaceOfLine } from '@evaos/chat-core/workspaces'
import { recordWorktrees } from './work-line'

const TITLE_MAX = 80
const HEADER_LINES = 4
/** Enough for the `title` and `session` records at the top; omp rewrites its title record in place. */
const HEADER_BYTES = 16 * 1024

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface SessionFacts {
  /** Title from the first records (a `title` record over the `session` header's title). */
  headTitle: string | null
  /** The last `title` record past the header (a rename appends one). */
  lastTitle: string | null
  /** The first prompt Isaac wrote on one line, `Image` when it is only images. */
  prompt: string | null
  cwd: string | null
  createdMs: number | null
  agent: ChatAgent
  /** Workspace the assistant's turns point at (native worked_in). */
  workedIn: string | null
  model: string | null
  /** The last reply stopped on an error or abort (cleared by a later prompt or reply). */
  failed: boolean
  jobs: BgJob[]
  /** `work/<dir>` folders the tool calls touched, most recent last, each once. */
  worktrees: string[]
  /** When Isaac last sent a prompt. */
  lastSentMs: number | null
  /** The last message leaves a turn in progress (a prompt, a tool result or a tool call). */
  turnOpen: boolean
}

interface Scan {
  mtimeMs: number
  size: number
  /** Bytes consumed: up to the end of the last whole line. */
  read: number
  lines: number
  agentDone: boolean
  facts: SessionFacts
}

/** Reads up to `length` bytes of `file` from byte `from`. */
export type ReadFrom = (file: string, from: number, length: number) => Buffer

export function readFrom(file: string, from: number, length: number): Buffer {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, length))
    let off = 0
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, from + off)
      if (n === 0) break
      off += n
    }
    return off === buf.length ? buf : buf.subarray(0, off)
  } finally {
    fs.closeSync(fd)
  }
}

const emptyFacts = (): SessionFacts => ({
  headTitle: null,
  lastTitle: null,
  prompt: null,
  cwd: null,
  createdMs: null,
  agent: 'Eva',
  workedIn: null,
  model: null,
  failed: false,
  jobs: [],
  worktrees: [],
  lastSentMs: null,
  turnOpen: false,
})

const ROLE = /"role":"([A-Za-z]+)"/
const STOP = '"stopReason":"'
/** Any WORK_PATHS marker, ignoring case: a cheap test before the ordered lowercase match. */
const WORK_MARKER =
  /ecardsystems\/|ecard-repos\/|react-client-reports-app|node-client-api-service|node-libraries-internal|platform-db-flyway|ecard-platform|work\/items\/eng-|apps\/evaos|work\/evaos-|work\/relay|apps\/mobile|work\/goodops|goodopshq\/|work\/texo|work\/flo|flodoc|work\/openflight|launch-monitor/i

function parse(line: string): Json | null {
  try {
    const v: unknown = JSON.parse(line)
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

const timeOf = (v: unknown): number | null => {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/** The raw model id one record names: an omp `model_change` or an assistant reply's provider/model. */
function modelOf(record: Json): string | null {
  if (record.isSidechain === true) return null
  let id: string | null = null
  if (record.type === 'model_change' && typeof record.model === 'string') id = record.model
  else if (
    record.type === 'message' &&
    isObj(record.message) &&
    record.message.role === 'assistant'
  ) {
    const m = record.message
    if (typeof m.model === 'string') {
      id = typeof m.provider === 'string' ? `${m.provider}/${m.model}` : m.model
    }
  }
  return id !== null && id !== '' && !id.startsWith('<') ? id : null
}

/** Per-file facts cached by mtime and size; a grown file is read only from where the last scan stopped. */
export class SessionScanner {
  private readonly scans = new Map<string, Scan>()

  constructor(
    private readonly home: string | null,
    private readonly read: ReadFrom = readFrom,
  ) {}

  /** Reads `file`'s header and appended bytes on the next look even if its mtime and size match. */
  stale(file: string): void {
    const scan = this.scans.get(file)
    if (scan) scan.mtimeMs = -1
  }

  clear(): void {
    this.scans.clear()
  }

  /** Drops every file not in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    for (const file of [...this.scans.keys()]) if (!keep.has(file)) this.scans.delete(file)
  }

  facts(file: string, st: { mtimeMs: number; size: number }): SessionFacts {
    let scan = this.scans.get(file)
    if (scan && scan.mtimeMs === st.mtimeMs && scan.size === st.size) return scan.facts
    const fresh = !scan || st.size < scan.read
    if (!scan || fresh) {
      scan = { mtimeMs: 0, size: 0, read: 0, lines: 0, agentDone: false, facts: emptyFacts() }
    }
    scan.mtimeMs = st.mtimeMs
    scan.size = st.size
    this.scans.set(file, scan)
    try {
      // omp rewrites its padded title record in place, so a grown file's header is read again.
      if (!fresh) this.header(scan.facts, this.read(file, 0, Math.min(HEADER_BYTES, st.size)))
      const buf = this.read(file, scan.read, st.size - scan.read)
      const end = buf.lastIndexOf(10) + 1
      if (end > 0) {
        this.apply(scan, buf.toString('utf8', 0, end))
        scan.read += end
      }
    } catch {
      // unreadable: what was known stays
    }
    return scan.facts
  }

  private apply(scan: Scan, text: string): void {
    const f = scan.facts
    const lines = text.split('\n')
    lines.pop()
    // `work/<dir>` paths only show up raw in a line unless the session itself runs inside `work/`.
    const anyCall = f.cwd !== null && /(^|\/)work(\/|$)/.test(f.cwd)
    if (scan.lines === 0) this.header(f, text)
    let offset = scan.read
    const modelLines: string[] = []
    for (const line of lines) {
      const at = offset
      if (!scan.agentDone) offset += Buffer.byteLength(line) + 1
      const n = scan.lines++
      if (line === '') continue
      if (n >= HEADER_LINES && line.includes('"type":"title"')) {
        const r = parse(line)
        if (r?.type === 'title' && typeof r.title === 'string' && r.title !== '') {
          f.lastTitle = r.title
        }
      }
      if (line.includes('"model_change"')) modelLines.push(line)
      let record: Json | null | undefined
      const parsed = (): Json | null => (record === undefined ? (record = parse(line)) : record)
      if (line.includes('"async"') || line.includes('"jobs"')) {
        const r = parsed()
        if (r) applyJobRecord(r, f.jobs, null)
      }
      if (!line.includes('"type":"message"')) continue
      if (!scan.agentDone) {
        if (at >= CLASSIFY_BYTES) scan.agentDone = true
        else {
          const agent = agentOfLine(line)
          if (agent !== null) {
            f.agent = agent
            scan.agentDone = true
          }
        }
      }
      const role = ROLE.exec(line)?.[1]
      if (role === 'user') {
        f.failed = false
        f.turnOpen = true
        const r = parsed()
        const message = r && isObj(r.message) ? r.message : null
        const prompt = message && r?.isSidechain !== true ? promptText(message) : null
        if (prompt !== null) {
          f.prompt ??= prompt.text.trim() === '' ? 'Image' : oneLine(prompt.text, TITLE_MAX)
          const sent = timeOf(r?.timestamp)
          if (sent !== null && (f.lastSentMs === null || sent > f.lastSentMs)) f.lastSentMs = sent
        }
      } else if (role === 'toolResult') {
        f.turnOpen = true
      } else if (role === 'assistant') {
        const stop = line.lastIndexOf(STOP)
        if (stop >= 0) {
          const reason = line.slice(stop + STOP.length, line.indexOf('"', stop + STOP.length))
          f.failed = reason === 'error' || reason === 'aborted'
          f.turnOpen = reason === 'toolUse'
        }
        if (f.workedIn === null && WORK_MARKER.test(line)) f.workedIn = workspaceOfLine(line)
        if (line.includes('"model"')) modelLines.push(line)
        if (f.cwd !== null && line.includes('"toolCall"') && (anyCall || line.includes('work'))) {
          const r = parsed()
          if (r) {
            for (const dir of recordWorktrees(r, f.cwd, this.home)) {
              const i = f.worktrees.indexOf(dir)
              if (i >= 0) f.worktrees.splice(i, 1)
              f.worktrees.push(dir)
            }
          }
        }
      }
    }
    // The model is the last record that names one; parse from the end until one does.
    for (let i = modelLines.length - 1; i >= 0; i--) {
      const r = parse(modelLines[i]!)
      const id = r ? modelOf(r) : null
      if (id !== null) {
        f.model = id
        break
      }
    }
  }

  /** The `title` and `session` records among the first lines of `head` (bytes or text). */
  private header(f: SessionFacts, head: Buffer | string): void {
    const text = typeof head === 'string' ? head : head.toString('utf8')
    f.headTitle = null
    f.cwd = null
    f.createdMs = null
    for (const line of text.split('\n', HEADER_LINES)) {
      const r = parse(line)
      if (!r) continue
      const title = typeof r.title === 'string' && r.title !== '' ? r.title : null
      if (r.type === 'title') {
        f.headTitle = title
      } else if (r.type === 'session') {
        f.cwd = typeof r.cwd === 'string' ? r.cwd : null
        f.createdMs = timeOf(r.timestamp)
        f.headTitle ??= title
      }
    }
  }
}
