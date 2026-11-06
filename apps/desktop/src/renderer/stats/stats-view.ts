import type { StatsRange, StatsRangeKey, StatsTotals } from '@evaos/contract'

/** Range picker labels and the phrase headlines use. */
export const RANGE_LABEL: Record<StatsRangeKey, { short: string; phrase: string }> = {
  '24h': { short: '24 hours', phrase: 'in the last 24 hours' },
  '7d': { short: '7 days', phrase: 'in the last 7 days' },
  '30d': { short: '30 days', phrase: 'in the last 30 days' },
}

const usd0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const whole = new Intl.NumberFormat('en-US')
const short = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

/** Dollars: cents below $1,000, whole dollars above. */
export function money(usd: number): string {
  return Math.abs(usd) >= 1000 ? usd0.format(usd) : usd2.format(usd)
}

export const count = (n: number): string => whole.format(n)
export const compact = (n: number): string => short.format(n)
/** Dollars for a chart axis: "$550", "$1.1K". */
export const moneyAxis = (usd: number): string => `$${short.format(usd)}`

/** A share as a percent: one decimal below 10% and above 99% (so 99.9% never reads as 100%). */
export function percent(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  const p = (part / whole) * 100
  if (p > 0 && p < 0.1) return '<0.1%'
  const precise = p < 10 || (p > 99 && p < 100)
  return `${precise ? (Math.floor(p * 10) / 10).toFixed(1) : Math.round(p).toString()}%`
}

/** Milliseconds as "850 ms" or "1.6 s"; a dash when unknown. */
export function duration(ms: number | null): string {
  if (ms === null) return '-'
  return ms < 1000 ? `${Math.round(ms).toString()} ms` : `${(ms / 1000).toFixed(1)} s`
}

export const rate = (tps: number | null): string =>
  tps === null ? '-' : Math.round(tps).toString()

/** Every token a request moved: prompt, cache reads and writes, and output. */
export const tokens = (t: StatsTotals): number =>
  t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens

/**
 * omp names a folder by its path from home with slashes as dashes (`-Eva` is the hub, `-Eva-work-relay`
 * a worktree under ~/Eva/work); folders outside home keep a leading slash (`/private-tmp-x/`).
 * Worktrees show by their own name, temp folders as `tmp/<name>`.
 */
export function folderLabel(folder: string): string {
  if (folder === '-Eva') return 'Eva hub'
  if (folder === '-Eva-work') return 'Eva work'
  if (folder.startsWith('-Eva-work-')) return folder.slice('-Eva-work-'.length)
  const tmp = /^(?:\/|--)private-tmp-?(.*?)[-/]*$/.exec(folder)
  if (tmp) return tmp[1] ? `tmp/${tmp[1]}` : 'tmp'
  return folder.replace(/^-+/, '') || folder
}

/** Rows under this share of spend fold into one "Everything else" row. */
const TAIL_SHARE = 0.01
const MAX_ROWS = 8

/**
 * The rows worth a line (at least 1% of spend, at most MAX_ROWS), and the rest of the range summed
 * from its totals, so the table always adds up even past the host's own row cap.
 */
export function headAndTail<R extends StatsTotals>(
  rows: readonly R[],
  total: StatsTotals,
): { head: R[]; tail: Pick<StatsTotals, 'costUsd' | 'requests' | 'failed'> | null } {
  const head = rows
    .filter((r) => total.costUsd <= 0 || r.costUsd / total.costUsd >= TAIL_SHARE)
    .slice(0, MAX_ROWS)
  const sum = (k: 'costUsd' | 'requests' | 'failed'): number =>
    Math.max(0, total[k] - head.reduce((s, r) => s + r[k], 0))
  const tail = { costUsd: sum('costUsd'), requests: sum('requests'), failed: sum('failed') }
  return { head, tail: tail.requests > 0 ? tail : null }
}

/** A request share over which a model counts as failing. */
const FAILING_RATE = 0.01
/** Fewer requests than this say nothing about a model's speed or failures. */
const MIN_REQUESTS = 20

export type InsightKind = 'cost' | 'agent' | 'failing' | 'slow'

export interface Insight {
  kind: InsightKind
  title: string
  detail: string
}

/** What is worth acting on in a range: the biggest cost, who spent it, what fails, what is slow. */
export function insights(range: StatsRange): Insight[] {
  const out: Insight[] = []
  const spend = range.totals.costUsd
  const top = range.byModel[0]
  if (top !== undefined && spend > 0) {
    out.push({
      kind: 'cost',
      title: `${top.model} is ${percent(top.costUsd, spend)} of spend`,
      detail: `${money(top.costUsd)} over ${count(top.requests)} requests`,
    })
  }
  const agent = range.byAgent[0]
  if (agent !== undefined && spend > 0) {
    out.push({
      kind: 'agent',
      title: `${agent.label} spent the most`,
      detail: `${money(agent.costUsd)}, ${percent(agent.costUsd, spend)} of spend`,
    })
  }
  const failing = range.byModel
    .filter((m) => m.requests >= MIN_REQUESTS && m.failed / m.requests >= FAILING_RATE)
    .sort((a, b) => b.failed / b.requests - a.failed / a.requests)[0]
  if (failing !== undefined) {
    out.push({
      kind: 'failing',
      title: `${failing.model} fails ${percent(failing.failed, failing.requests)} of requests`,
      detail: `${count(failing.failed)} of ${count(failing.requests)} ended in an error`,
    })
  }
  const timed = range.byModel.filter((m) => m.requests >= MIN_REQUESTS && m.avgTtftMs !== null)
  const slow = [...timed].sort((a, b) => (b.avgTtftMs ?? 0) - (a.avgTtftMs ?? 0))[0]
  const fast = [...timed].sort((a, b) => (a.avgTtftMs ?? 0) - (b.avgTtftMs ?? 0))[0]
  if (slow !== undefined && fast !== undefined && slow !== fast) {
    out.push({
      kind: 'slow',
      title: `${slow.model} is slowest to answer`,
      detail: `${duration(slow.avgTtftMs)} to first token, ${fast.model} takes ${duration(fast.avgTtftMs)}`,
    })
  }
  return out
}
