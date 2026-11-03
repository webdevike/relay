// Jobs data rules, ported from apps/evaos/src/jobs.rs and .omp/tools/job-run.ts.
// Pure: no filesystem. Reading jobs/ lives in jobs-read.ts.

export interface JobSettings {
  /** '' means unset (manual). */
  every: string
  enabled: boolean
  /** '' means the runner default. */
  maxRun: string
  /** '' means the runner default. */
  keep: string
}

export interface JobFieldErrors {
  name?: string
  every?: string
  maxRun?: string
  keep?: string
  steps?: string
}

export const JOB_COPY = {
  nameRule: 'Use lowercase letters, numbers and hyphens, starting with a letter or number.',
  nameTaken: (name: string): string => `A job named ${name} already exists.`,
  duration: 'Use a number followed by m, h or d, like 30m, 2h or 1d.',
  zero: 'Must be more than zero.',
  steps: 'Write at least one step.',
  keepHelp: 'How long the session stays open for replies. Empty uses 30m.',
} as const

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** About a year; larger values are rejected so due times stay safe integers. */
const MAX_DURATION_MS = 366 * 86_400_000

/** The runner's duration syntax in ms (bare number is minutes), or null when invalid. */
export function parseDuration(text: string): number | null {
  const m = /^(\d{1,9})[ \t]*(ms|s|m|h|d)?$/.exec(text.trim())
  if (!m) return null
  const ms = Number(m[1]) * UNIT_MS[m[2] ?? 'm']!
  return ms > MAX_DURATION_MS ? null : ms
}

/** null when the name is a valid job folder name, else the rule text. */
export function nameError(name: string): string | null {
  return /^[a-z0-9][a-z0-9-]*$/.test(name) ? null : JOB_COPY.nameRule
}

const KEY_RE = /^([A-Za-z_][\w-]*):\s*(.*)$/

function lineKey(line: string): { key: string; value: string } | null {
  const m = KEY_RE.exec(line)
  return m ? { key: m[1]!, value: m[2]! } : null
}

function cleanValue(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, '')
}

/** A parsed job.md that writes back unchanged except for what was edited. */
export class JobDoc {
  private constructor(
    private readonly lines: readonly string[],
    private readonly closeNewline: boolean,
    private readonly body: string,
  ) {}

  /** Splits like the runner's /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/. */
  static parse(text: string): JobDoc {
    const m = /^---\n([\s\S]*?)\n---(\n?)([\s\S]*)$/.exec(text)
    if (m) return new JobDoc(m[1]!.split('\n'), m[2] === '\n', m[3]!)
    return new JobDoc([], true, text)
  }

  render(): string {
    if (this.lines.length === 0) return this.body
    return `---\n${this.lines.join('\n')}\n---${this.closeNewline ? '\n' : ''}${this.body}`
  }

  /** A key's value as the runner reads it (last occurrence wins), or null. */
  get(key: string): string | null {
    let found: string | null = null
    for (const line of this.lines) {
      const kv = lineKey(line)
      if (kv && kv.key === key) found = cleanValue(kv.value)
    }
    return found
  }

  settings(): JobSettings {
    return {
      every: this.get('every') ?? '',
      enabled: this.get('enabled') !== 'false',
      maxRun: this.get('max_run') ?? '',
      keep: this.get('keep') ?? '',
    }
  }

  /** The step text (body), untrimmed. */
  steps(): string {
    return this.body
  }

  /** Keys other than the managed ones, in first-seen order. */
  extraKeys(): string[] {
    const managed = new Set(['every', 'enabled', 'max_run', 'keep'])
    const out: string[] = []
    for (const line of this.lines) {
      const kv = lineKey(line)
      if (kv && !managed.has(kv.key) && !out.includes(kv.key)) out.push(kv.key)
    }
    return out
  }

  private set(key: string, value: string | null): JobDoc {
    const isKey = (line: string) => lineKey(line)?.key === key
    let lines: string[]
    if (value === null) {
      lines = this.lines.filter((l) => !isKey(l))
    } else {
      const first = this.lines.findIndex(isKey)
      if (first < 0) lines = [...this.lines, `${key}: ${value}`]
      else {
        lines = this.lines.filter((l, i) => i <= first || !isKey(l))
        lines[first] = `${key}: ${value}`
      }
    }
    return new JobDoc(lines, this.closeNewline, this.body)
  }

  /** Writes only changed settings, so unchanged lines keep their exact text. */
  apply(next: JobSettings): JobDoc {
    const cur = this.settings()
    let doc = new JobDoc(this.lines, this.closeNewline, this.body)
    for (const [key, old, val] of [
      ['every', cur.every, next.every],
      ['max_run', cur.maxRun, next.maxRun],
      ['keep', cur.keep, next.keep],
    ] as const) {
      const v = val.trim()
      if (old.trim() !== v) doc = doc.set(key, v === '' ? null : v)
    }
    return doc.setEnabled(next.enabled)
  }

  /** false writes `enabled: false`; true rewrites an existing line and adds none. */
  setEnabled(on: boolean): JobDoc {
    if (this.settings().enabled === on) return this
    if (on) return this.set('enabled', this.get('enabled') !== null ? 'true' : null)
    return this.set('enabled', 'false')
  }

  /** Replaces the body, ensuring a trailing newline. */
  withSteps(steps: string): JobDoc {
    const body = steps.endsWith('\n') ? steps : `${steps}\n`
    return new JobDoc(this.lines, this.closeNewline, body)
  }
}

export function validateJob(input: {
  name: string
  mode: 'create' | 'update'
  settings: JobSettings
  steps: string
  existingNames: string[]
}): JobFieldErrors {
  const errors: JobFieldErrors = {}
  const nameErr = nameError(input.name)
  if (nameErr) errors.name = nameErr
  else if (input.mode === 'create' && input.existingNames.includes(input.name)) {
    errors.name = JOB_COPY.nameTaken(input.name)
  }
  const duration = (value: string, allowZero: boolean): string | undefined => {
    // Control characters (newlines) would corrupt the frontmatter line this value is written to.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value.trim())) return JOB_COPY.duration
    const v = value.trim()
    if (v === '') return undefined
    const ms = parseDuration(v)
    if (ms === null) return JOB_COPY.duration
    if (ms === 0 && !allowZero) return JOB_COPY.zero
    return undefined
  }
  const every = duration(input.settings.every, false)
  const maxRun = duration(input.settings.maxRun, false)
  const keep = duration(input.settings.keep, true)
  if (every) errors.every = every
  if (maxRun) errors.maxRun = maxRun
  if (keep) errors.keep = keep
  if (input.steps.trim() === '') errors.steps = JOB_COPY.steps
  return errors
}

/** Interval in ms for a scheduled job; null for manual (empty, invalid or zero). */
export function everyMs(every: string | null | undefined): number | null {
  if (!every) return null
  const ms = parseDuration(every)
  return ms !== null && ms > 0 ? ms : null
}

export function scheduleLabel(every: string | null): string {
  return everyMs(every) !== null ? `Every ${every!.trim()}` : 'Manual'
}

/** Epoch ms when the scheduler next launches the job; null for manual or disabled. */
export function nextDue(settings: JobSettings, lastRunMs: number | null): number | null {
  if (!settings.enabled) return null
  const every = everyMs(settings.every)
  if (every === null) return null
  if (lastRunMs === null) return 0
  return lastRunMs + every
}

function span(ms: number): string | null {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return null
  if (minutes < 60) return `${minutes}m`
  if (minutes < 2880) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / 1440)}d`
}

export function agoLabel(thenMs: number, nowMs: number): string {
  const s = span(nowMs - thenMs)
  return s === null ? 'just now' : `${s} ago`
}

export function untilLabel(atMs: number, nowMs: number): string {
  if (atMs <= nowMs) return 'due now'
  const s = span(atMs - nowMs)
  return s === null ? 'in under a minute' : `in ${s}`
}
