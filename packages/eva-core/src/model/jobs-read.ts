// Read-only reader for jobs/ and jobs/.runs/. Never writes: the runner owns .runs.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { everyMs, JobDoc, nameError, nextDue } from './jobs'

export type RunState = 'running' | 'ok' | 'failed' | 'never' | 'other'

export interface JobSummary {
  name: string
  description: string | null
  every: string | null
  enabled: boolean
  scheduled: boolean
  maxRun: string | null
  keep: string | null
  lastRunAt: number | null
  runState: RunState
  runStateRaw: string | null
  runNote: string | null
  sessionFile: string | null
  nextDueAt: number | null
  hasScript: boolean
}

export interface JobsReadOpts {
  pidAlive?: (pid: number) => boolean
  fileExists?: (path: string) => boolean
}

const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{6}$/

/** Signal 0 only checks existence and sends nothing; EPERM means alive. */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A lock is live when its first whitespace token is a live pid (the runner's rule). */
export function isLockLive(text: string, pidAlive: (pid: number) => boolean): boolean {
  const pid = Number(text.trim().split(/\s+/)[0])
  if (!Number.isInteger(pid) || pid <= 0) return false
  return pidAlive(pid)
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function lockLive(path: string, pidAlive: (pid: number) => boolean): boolean {
  if (!existsSync(path)) return false
  const text = readText(path)
  // Unreadable lock: conservative, treat as live.
  if (text === null) return true
  return isLockLive(text, pidAlive)
}

interface Latest {
  state: string
  note: string | null
  sessionFile: string | null
}

function latestRun(runsDir: string): Latest | null {
  let ids: string[]
  try {
    ids = readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && RUN_ID.test(e.name))
      .filter((e) => existsSync(join(runsDir, e.name, 'status.json')))
      .map((e) => e.name)
  } catch {
    return null
  }
  const id = ids.sort().at(-1)
  if (!id) return null
  const text = readText(join(runsDir, id, 'status.json'))
  if (text === null) return null
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    const str = (k: string) => (typeof json[k] === 'string' ? (json[k] as string) : null)
    return { state: str('state') ?? 'unknown', note: str('note'), sessionFile: str('sessionFile') }
  } catch {
    return null
  }
}

export function readJobRun(
  root: string,
  name: string,
  opts: JobsReadOpts = {},
): Pick<JobSummary, 'lastRunAt' | 'runState' | 'runStateRaw' | 'runNote' | 'sessionFile'> {
  const pidAlive = opts.pidAlive ?? defaultPidAlive
  const fileExists = opts.fileExists ?? existsSync
  const runs = join(root, 'jobs', '.runs')
  const lastText = readText(join(runs, name, 'last-run'))
  const lastN = lastText === null ? NaN : Number(lastText.trim())
  const lastRunAt = Number.isFinite(lastN) && lastN > 0 ? Math.floor(lastN) : null
  const latest = latestRun(join(runs, name))
  const sessionFile =
    latest?.sessionFile && fileExists(latest.sessionFile) ? latest.sessionFile : null
  const base = { lastRunAt, runNote: latest?.note?.slice(0, 500) ?? null, sessionFile }
  if (lockLive(join(runs, `${name}.lock`), pidAlive)) {
    return { ...base, runState: 'running', runStateRaw: null }
  }
  if (!latest) return { ...base, runState: 'never', runStateRaw: null }
  switch (latest.state) {
    case 'done':
      return { ...base, runState: 'ok', runStateRaw: null }
    case 'failed':
    case 'timeout':
    case 'killed':
      return { ...base, runState: 'failed', runStateRaw: null }
    default:
      return { ...base, runState: 'other', runStateRaw: latest.state }
  }
}

function firstLine(body: string): string | null {
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (t) return t.slice(0, 500)
  }
  return null
}

/** Every job under root/jobs, sorted by name. */
export function listJobs(root: string, nowMs: number, opts: JobsReadOpts = {}): JobSummary[] {
  void nowMs
  let names: string[]
  try {
    names = readdirSync(join(root, 'jobs'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && nameError(e.name) === null && e.name.length <= 64)
      .map((e) => e.name)
  } catch {
    return []
  }
  const out: JobSummary[] = []
  for (const name of names.sort()) {
    const text = readText(join(root, 'jobs', name, 'job.md'))
    if (text === null) continue
    const doc = JobDoc.parse(text)
    const s = doc.settings()
    const run = readJobRun(root, name, opts)
    out.push({
      name,
      description: firstLine(doc.steps()),
      every: s.every || null,
      enabled: s.enabled,
      scheduled: s.enabled && everyMs(s.every) !== null,
      maxRun: s.maxRun || null,
      keep: s.keep || null,
      ...run,
      nextDueAt: nextDue(s, run.lastRunAt),
      hasScript: doc.get('script') !== null,
    })
  }
  return out
}
