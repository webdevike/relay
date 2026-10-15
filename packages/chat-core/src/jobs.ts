// Background jobs and subagents derived from session files. Pure over text and listings;
// callers in main read the files. Ported from Rust chat.rs background_jobs / subagents.
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

function applyRecord(record: Json, running: BgJob[], commands: Map<string, string>): void {
  const message = isObj(record.message) ? record.message : {}
  if (Array.isArray(message.content)) {
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
      const command = call === undefined ? undefined : commands.get(call)
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
    if (isObj(record)) applyRecord(record, running, commands)
  }
  return running
}

export interface SubagentEntry {
  name: string
  file: string
  mtimeMs: number
  done: boolean
}

/**
 * Subagents from the direct entries of a session's folder, newest first. A `<name>.jsonl`
 * transcript is done once omp wrote `<name>.md`. (Claude callers override `done` with
 * claudeSubagentDone on the transcript text.)
 */
export function subagentsFromListing(
  entries: ReadonlyArray<{ name: string; mtimeMs: number }>,
): SubagentEntry[] {
  const names = new Set(entries.map((e) => e.name))
  return entries
    .filter((e) => e.name.endsWith('.jsonl'))
    .map((e) => {
      const stem = e.name.slice(0, -'.jsonl'.length)
      return { name: stem, file: e.name, mtimeMs: e.mtimeMs, done: names.has(`${stem}.md`) }
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
