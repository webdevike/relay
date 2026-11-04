// Background jobs and subagents derived from session files. Pure over text and listings;
// callers in main read the files. Ported from Rust chat.rs background_jobs / subagents.
import { SUBAGENT_STALE_MS } from './artifacts'
import { oneLine } from './session'

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export interface BgJob {
  id: string
  label: string
  kind: string
  startedAt: number
}

/**
 * Folds one session record into the open jobs. `commands` maps tool call ids to their commands for
 * job labels; null skips labels (the list only counts jobs).
 */
export function applyJobRecord(
  record: Json,
  running: BgJob[],
  commands: Map<string, string> | null,
): void {
  const message = isObj(record.message) ? record.message : {}
  if (commands !== null && Array.isArray(message.content)) {
    for (const part of message.content as unknown[]) {
      if (!isObj(part) || part.type !== 'toolCall') continue
      const id = str(part.id)
      const command = isObj(part.arguments) ? str(part.arguments.command) : undefined
      if (id !== undefined && command !== undefined) commands.set(id, command)
    }
  }
  const rawDetails = record.type === 'custom_message' ? record.details : message.details
  const details = isObj(rawDetails) ? rawDetails : {}
  const started = isObj(details.async) ? details.async : {}
  const jobId = str(started.jobId)
  if (started.state === 'running' && jobId !== undefined) {
    const kind = str(started.type) ?? 'job'
    if (kind !== 'task') {
      const at = running.findIndex((j) => j.id === jobId)
      if (at >= 0) running.splice(at, 1)
      const call = str(message.toolCallId)
      const command = call === undefined ? undefined : commands?.get(call)
      const ts = Date.parse(str(record.timestamp) ?? '')
      running.push({
        id: jobId,
        kind,
        label: command === undefined ? jobId : oneLine(command, 160),
        startedAt: Number.isNaN(ts) ? 0 : ts,
      })
    }
  }
  if (Array.isArray(details.jobs)) {
    for (const job of details.jobs as unknown[]) {
      if (!isObj(job)) continue
      // Deliveries name `jobId`; `wait` snapshots name `id` with a status.
      const ended =
        str(job.jobId) ??
        (str(job.id) !== undefined && job.status !== 'running' ? str(job.id) : undefined)
      if (ended === undefined) continue
      const at = running.findIndex((j) => j.id === ended)
      if (at >= 0) running.splice(at, 1)
    }
  }
}

/** Jobs a session started that have not finished, oldest first. Subagent (`task`) jobs are left out. */
export function backgroundJobs(text: string): BgJob[] {
  const running: BgJob[] = []
  const commands = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!(line.includes('"toolCall"') || line.includes('"jobs"') || line.includes('"async"')))
      continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (isObj(record)) applyJobRecord(record, running, commands)
  }
  return running
}

export interface SubagentEntry {
  name: string
  file: string
  mtimeMs: number
  done: boolean
  /** When omp wrote the `.md` (set when it exists): a transcript newer than this was written to since. */
  resultMtimeMs?: number
}

/** A transcript this much newer than its result file was written to after the result. */
export const RESUME_SLACK_MS = 1000

/**
 * Whether a listed subagent's run is over: omp wrote its `.md`, or its transcript ends with the
 * `yield` result or `session_exit`. A helper woken by a follow-up message writes to its transcript
 * again while the old `.md` still sits beside it, so a `.md` older than a transcript that does not
 * end is no ending: the helper runs again. `text` is the transcript (or its tail); '' says nothing
 * and leaves the `.md` as the answer.
 */
export function subagentOver(s: SubagentEntry, text: string): boolean {
  const woken =
    s.done &&
    s.resultMtimeMs !== undefined &&
    s.mtimeMs > s.resultMtimeMs + RESUME_SLACK_MS &&
    text !== '' &&
    !ompSubagentEnded(text)
  return !woken && (s.done || ompSubagentEnded(text))
}

/**
 * Whether a listed subagent is over: its `.md` exists, or its transcript went untouched for
 * SUBAGENT_STALE_MS (crashed, killed). The chips, the context dot and the Artifacts panel agree on it.
 */
export function subagentFinished(s: { done: boolean; mtimeMs: number }, now: number): boolean {
  return s.done || now - s.mtimeMs > SUBAGENT_STALE_MS
}

/**
 * Subagents from the direct entries of a session's folder, newest first. A `<name>.jsonl`
 * transcript is done once omp wrote `<name>.md`. (Claude callers override `done` with
 * claudeSubagentDone on the transcript text.)
 */
export function subagentsFromListing(
  entries: ReadonlyArray<{ name: string; mtimeMs: number }>,
): SubagentEntry[] {
  const results = new Map(entries.map((e) => [e.name, e.mtimeMs]))
  return entries
    .filter((e) => e.name.endsWith('.jsonl'))
    .map((e) => {
      const stem = e.name.slice(0, -'.jsonl'.length)
      const result = results.get(`${stem}.md`)
      return {
        name: stem,
        file: e.name,
        mtimeMs: e.mtimeMs,
        done: result !== undefined,
        ...(result === undefined ? {} : { resultMtimeMs: result }),
      }
    })
    .filter((e) => e.name !== '')
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** A Claude subagent is done when its transcript ends on an assistant reply with no tool_use. */
export function claudeSubagentDone(text: string): boolean {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let record: unknown
    try {
      record = JSON.parse(lines[i] as string)
    } catch {
      continue
    }
    if (!isObj(record) || typeof record.uuid !== 'string') continue
    if (record.type !== 'user' && record.type !== 'assistant') continue
    if (record.type !== 'assistant') return false
    const content = isObj(record.message) ? record.message.content : undefined
    return !(Array.isArray(content) && content.some((b) => isObj(b) && b.type === 'tool_use'))
  }
  return false
}

/**
 * An omp subagent is over when its transcript's last record is `session_exit`, or the result of its
 * `yield` call. The `.md` beside it says the same, but a mirrored transcript (the other Mac) never
 * has the `.md`, and a missed file event leaves a local chip without it until the next listing.
 */
export function ompSubagentEnded(text: string): boolean {
  let end = text.length
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const line = text.slice(start, end).trim()
    end = start - 1
    if (line === '') continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(record)) continue
    if (record.type === 'custom') {
      if (record.customType === 'session_exit') return true
      continue
    }
    if (record.type !== 'message' || !isObj(record.message)) continue
    return record.message.role === 'toolResult' && record.message.toolName === 'yield'
  }
  return false
}
