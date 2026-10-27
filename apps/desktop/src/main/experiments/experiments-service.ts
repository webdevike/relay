import type { Dirent } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  ExperimentIdSchema,
  ExperimentStatusFileSchema,
  ExperimentSummaryFileSchema,
  isLegacyCost,
  type ArmSummary,
  type ExperimentCase,
  type ExperimentCases,
  type HeadlineSide,
  type ExperimentDetail,
  type ExperimentRow,
  type ExperimentStatus,
  type ExperimentStatusFile,
  type ExperimentSummaryFile,
} from '@evaos/contract'

/** Text files above this size are not read (a results table is a few KB). */
const MAX_TEXT_BYTES = 2 * 1024 * 1024
/** The case list stops here; summary.json carries the totals. */
export const MAX_CASES = 5000
const MAX_CASES_BYTES = 16 * 1024 * 1024

export interface ExperimentsService {
  /** Every experiment folder, newest first. */
  list(): Promise<ExperimentRow[]>
  get(id: string): Promise<ExperimentDetail>
  /** The run lines of one arm, from summary.json's casesFile. */
  cases(id: string, arm: string): Promise<ExperimentCases>
}

async function readText(file: string, max = MAX_TEXT_BYTES): Promise<string | null> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > max) return null
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

export interface RecordFacts {
  title: string | null
  question: string | null
  verdict: string | null
  arms: number | null
}

/** The `## <heading>` section body, up to the next heading of level two or higher. */
function section(md: string, heading: RegExp): string | null {
  const lines = md.split('\n')
  const start = lines.findIndex((l) => heading.test(l))
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l))
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim()
}

/** What record.md says, from the experiment template's fixed headings and lines. */
export function parseRecord(md: string): RecordFacts {
  const title = /^#\s+(?:Experiment:\s*)?(.+?)\s*$/m.exec(md)?.[1] ?? null
  const question = /^-\s*Question:\s*(.+?)\s*$/m.exec(md)?.[1] ?? null
  const verdict = section(md, /^##\s+Verdict\b/)
  const rows = section(md, /^##\s+(?:3\.\s*)?Arms\b/)
    ?.split('\n')
    .filter((l) => l.trim().startsWith('|'))
    // Header row and the `|:--|` alignment row.
    .slice(2)
  return {
    title,
    // The template's placeholders (`<one question>`) are not answers.
    question: question && !question.startsWith('<') ? question : null,
    verdict: verdict && !verdict.startsWith('<') ? verdict : null,
    arms: rows && rows.length > 0 ? rows.length : null,
  }
}

/** PASS / FAIL / INCONCLUSIVE leading a verdict line (bold or a `Verdict:` prefix allowed). */
export function verdictStatus(text: string | null | undefined): ExperimentStatus | null {
  const m = /^[\s*#_]*(?:verdict:?\s*)?[*_]*\s*(pass(?:ed)?|fail(?:ed)?|inconclusive)\b/i.exec(
    text ?? '',
  )
  if (!m) return null
  const word = m[1]!.toLowerCase()
  return word.startsWith('pass') ? 'pass' : word.startsWith('fail') ? 'fail' : 'inconclusive'
}

export function overallStatus(
  live: ExperimentStatusFile | null,
  summary: ExperimentSummaryFile | null,
  recordVerdict: string | null,
  results: string | null,
): ExperimentStatus {
  if (live?.status === 'running') return 'running'
  if (summary && summary.status !== 'planned') return summary.status
  // Older experiments: the record's verdict, else results.md's `## Verdict: FAIL` line.
  const resultsLine = results ? /^#{1,3}\s+Verdict\b.*$/im.exec(results)?.[0] : undefined
  return (
    verdictStatus(recordVerdict) ??
    verdictStatus(resultsLine?.replace(/^#+\s*/, '')) ??
    summary?.status ??
    'planned'
  )
}

/** The headline metric: the dev-holdout gap's metric (the primary), else the first quality rate. */
export function primaryMetric(arms: readonly ArmSummary[]): string | null {
  return (
    arms.find((a) => a.gap)?.gap?.metric ?? arms.flatMap((a) => a.quality ?? [])[0]?.metric ?? null
  )
}

const SPLIT_ORDER = ['holdout', 'dev'] as const

/** Control against the best other arm on the primary metric, read on holdout when it ran. */
export function headline(arms: readonly ArmSummary[]): NonNullable<ExperimentRow['headline']> {
  const metric = primaryMetric(arms)
  if (!metric) return { control: null, best: null }
  const side = (arm: ArmSummary): HeadlineSide | null => {
    const rates = (arm.quality ?? []).filter((q) => q.metric === metric)
    const rate = SPLIT_ORDER.map((s) => rates.find((q) => q.split === s)).find(Boolean)
    return rate ? { arm: arm.id, label: arm.label, metric: rate } : null
  }
  const control = arms.find((a) => a.role === 'control') ?? null
  let best: HeadlineSide | null = null
  for (const arm of arms) {
    if (arm === control) continue
    const s = side(arm)
    if (s && (best === null || s.metric.p > best.metric.p)) best = s
  }
  return { control: control ? side(control) : null, best }
}

/** The list row's cost totals over every arm (see `ExperimentRow['cost']`). */
export function costTotals(arms: readonly ArmSummary[]): NonNullable<ExperimentRow['cost']> {
  let tokens: number | null = null
  let listUsd: number | null = null
  let billedUsd: number | null = null
  let unpricedArms = 0
  for (const { cost } of arms) {
    if (!cost) continue
    if (isLegacyCost(cost)) {
      if (cost.unit === 'tokens') {
        tokens = (tokens ?? 0) + cost.total
        unpricedArms++
      } else billedUsd = (billedUsd ?? 0) + cost.total
      continue
    }
    if (cost.tokens) tokens = (tokens ?? 0) + cost.tokens.total
    if (cost.listUsd) listUsd = (listUsd ?? 0) + cost.listUsd.total
    else if (cost.tokens) unpricedArms++
    if (cost.billedUsd) billedUsd = (billedUsd ?? 0) + cost.billedUsd.total
  }
  return { tokens, listUsd, unpricedArms, billedUsd }
}

interface Loaded {
  id: string
  dir: string
  record: RecordFacts
  results: string | null
  summary: ExperimentSummaryFile | null
  summaryError: string | null
  live: ExperimentStatusFile | null
  rounds: string[]
  updatedAt: number
}

function parseJson<T>(
  text: string | null,
  parse: (v: unknown) => T,
): { value: T | null; error: string | null } {
  if (text === null) return { value: null, error: null }
  try {
    return { value: parse(JSON.parse(text)), error: null }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { value: null, error: message.length > 400 ? `${message.slice(0, 400)}...` : message }
  }
}

export function createExperimentsService(root: string): ExperimentsService {
  async function load(id: string): Promise<Loaded> {
    ExperimentIdSchema.parse(id)
    const dir = path.join(root, id)
    const files = ['record.md', 'results.md', 'summary.json', 'status.json', 'rounds'].map((f) =>
      path.join(dir, f),
    )
    const [recordMd, results, summaryText, statusText, roundNames, times] = await Promise.all([
      readText(files[0]!),
      readText(files[1]!),
      readText(files[2]!),
      readText(files[3]!),
      fs.readdir(files[4]!).catch(() => [] as string[]),
      Promise.all(
        [...files, dir].map((f) =>
          fs.stat(f).then(
            (s) => s.mtimeMs,
            () => 0,
          ),
        ),
      ),
    ])
    const summary = parseJson(summaryText, (v) => ExperimentSummaryFileSchema.parse(v))
    return {
      id,
      dir,
      record: recordMd
        ? parseRecord(recordMd)
        : { title: null, question: null, verdict: null, arms: null },
      results,
      summary: summary.value,
      summaryError: summary.error,
      // A half-written or foreign status.json only costs the live progress.
      live: parseJson(statusText, (v) => ExperimentStatusFileSchema.parse(v)).value,
      rounds: roundNames
        .filter((n) => n.endsWith('.md'))
        .map((n) => n.slice(0, -3))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      updatedAt: Math.max(...times),
    }
  }

  function row(l: Loaded): ExperimentRow {
    const date = /^(\d{4}-\d{2}-\d{2})-/.exec(l.id)?.[1] ?? null
    const status = overallStatus(l.live, l.summary, l.record.verdict, l.results)
    const running = status === 'running' && l.live?.status === 'running' ? l.live : null
    const round = running?.round ?? l.summary?.round ?? l.live?.round
    return {
      id: l.id,
      date,
      title: l.summary?.title ?? l.record.title ?? (date ? l.id.slice(date.length + 1) : l.id),
      status,
      progress: running ? { done: running.casesDone, planned: running.casesPlanned } : null,
      round: round !== undefined ? String(round) : (l.rounds.at(-1) ?? null),
      arms: l.summary?.arms.length ?? l.record.arms,
      headline: l.summary ? headline(l.summary.arms) : null,
      cost: l.summary ? costTotals(l.summary.arms) : null,
      hasSummary: l.summary !== null,
      updatedAt: l.updatedAt,
    }
  }

  async function existing(id: string): Promise<Loaded> {
    ExperimentIdSchema.parse(id)
    if (!(await fs.stat(path.join(root, id)).catch(() => null))?.isDirectory())
      throw Object.assign(new Error(`No experiment ${id}`), { code: 'not-found' })
    return load(id)
  }

  return {
    async list() {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(root, { withFileTypes: true })
      } catch {
        return []
      }
      const ids = entries
        .filter((e) => e.isDirectory() && ExperimentIdSchema.safeParse(e.name).success)
        .map((e) => e.name)
      const rows = (await Promise.all(ids.map(load))).map(row)
      // Folder date first; a folder without one sorts by the day it last changed.
      const day = (r: ExperimentRow) => r.date ?? new Date(r.updatedAt).toISOString().slice(0, 10)
      return rows.sort(
        (a, b) =>
          day(b).localeCompare(day(a)) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
      )
    },

    async get(id) {
      const l = await existing(id)
      return {
        ...row(l),
        question: l.summary?.question ?? l.record.question,
        verdict: l.summary?.verdict ?? l.record.verdict,
        primary: l.summary ? primaryMetric(l.summary.arms) : null,
        armSummaries: l.summary?.arms ?? null,
        resultsMarkdown: l.results,
        summaryError: l.summaryError,
      }
    },

    async cases(id, armId) {
      const l = await existing(id)
      const empty = (reason: string, file: string | null = null): ExperimentCases => ({
        file,
        cases: [],
        invalid: 0,
        truncated: false,
        reason,
      })
      if (!l.summary) return empty('This experiment has no summary.json yet.')
      const arm = l.summary.arms.find((a) => a.id === armId)
      if (!arm) return empty(`summary.json has no arm ${armId}.`)
      const rel = arm.casesFile
      const base = await fs.realpath(l.dir)
      const real = await fs.realpath(path.resolve(l.dir, rel)).catch(() => null)
      if (real === null) return empty(`${rel} does not exist yet.`, rel)
      if (!real.startsWith(base + path.sep)) return empty(`${rel} is outside the experiment.`, rel)
      const text = await readText(real, MAX_CASES_BYTES)
      if (text === null) return empty(`${rel} is not a readable file under 16 MB.`, rel)
      return { file: rel, ...parseCases(text), reason: null }
    },
  }
}

/** One compact line for a scored outcome: `pass` / `fail` when it carries one, plus the rest. */
function outcomeOf(outcome: unknown): { text: string | null; passed: boolean | null } {
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome))
    return { text: null, passed: null }
  const entries = Object.entries(outcome)
  const flagEntry = entries.find(
    ([k, v]) => (k === 'pass' || k === 'correct') && typeof v === 'boolean',
  )
  const passed = flagEntry ? flagEntry[1] === true : null
  const rest = entries.filter(([k]) => k !== flagEntry?.[0])
  const text = [
    passed === null ? '' : passed ? 'pass' : 'fail',
    rest.length ? JSON.stringify(Object.fromEntries(rest)) : '',
  ]
    .filter(Boolean)
    .join(' ')
  return { text: text.length > 300 ? `${text.slice(0, 300)}...` : text || '{}', passed }
}

export function parseCases(text: string): Omit<ExperimentCases, 'file' | 'reason'> {
  const cases: ExperimentCase[] = []
  let invalid = 0
  let truncated = false
  const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (cases.length >= MAX_CASES) {
      truncated = true
      break
    }
    let l: unknown
    try {
      l = JSON.parse(line)
    } catch {
      invalid++
      continue
    }
    if (!l || typeof l !== 'object' || !('case' in l) || typeof l.case !== 'string') {
      invalid++
      continue
    }
    const rec: Record<string, unknown> = Object.fromEntries(Object.entries(l))
    const outcome = outcomeOf(rec.outcome)
    const error = nonEmpty(rec.error)
    const { seconds, repeat } = rec
    cases.push({
      case: l.case,
      split: nonEmpty(rec.split) ?? '',
      repeat: typeof repeat === 'number' ? repeat : null,
      outcome: outcome.text,
      passed: outcome.passed,
      seconds: typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null,
      error: rec.timeout === true ? (error ? `timeout: ${error}` : 'timeout') : error,
      skipped: nonEmpty(rec.skipped),
    })
  }
  return { cases, invalid, truncated }
}
