import type { ReviewQueue, ReviewRow } from '@evaos/contract'

export const prKey = (r: { repo: string; number: number }): string => `${r.repo}#${r.number}`

/** `3d`, `29m`, `just now`: the queue's and timeline's short ages. */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return s < 5 ? 'just now' : `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d`
  return `${Math.round(d / 30)}mo`
}

/** A row stays hidden after Done until the PR changes again. */
export function isDone(row: ReviewRow, done: Record<string, number>): boolean {
  const at = done[row.url]
  return at !== undefined && row.updatedAt <= at
}

export interface QueueGroup {
  id: 'needs' | 'reviewing' | 'completed' | 'created'
  label: string
  rows: ReviewRow[]
  /** Shown count (Completed counts every finished review, not just the ones listed). */
  count: number
  /** The line under each row's title. */
  subtitle: string
}

export function queueGroups(q: ReviewQueue, view: 'for-me' | 'created'): QueueGroup[] {
  const live = (rows: ReviewRow[]) => rows.filter((r) => !isDone(r, q.done))
  if (view === 'created') {
    const rows = live(q.created)
    return [{ id: 'created', label: 'Open', rows, count: rows.length, subtitle: 'Waiting on reviewers' }]
  }
  const needs = live(q.needs)
  const reviewing = live(q.reviewing)
  return [
    { id: 'needs', label: 'Needs your review', rows: needs, count: needs.length, subtitle: 'Waiting for your review' },
    { id: 'reviewing', label: "You're reviewing", rows: reviewing, count: reviewing.length, subtitle: 'You reviewed it' },
    { id: 'completed', label: 'Completed', rows: q.completed, count: q.completedTotal, subtitle: 'Closed' },
  ]
}

/** The first row in queue order after `key` (or before it when it was last); null when none. */
export function nextAfter(groups: readonly QueueGroup[], key: string): ReviewRow | null {
  const rows = groups.filter((g) => g.id !== 'completed').flatMap((g) => g.rows)
  const at = rows.findIndex((r) => prKey(r) === key)
  const rest = rows.filter((r) => prKey(r) !== key)
  if (rest.length === 0) return null
  return rest[Math.min(Math.max(at, 0), rest.length - 1)] ?? null
}

/** Mentioning Astra makes a comment a private question to her instead of a GitHub comment. */
export const mentionsAstra = (text: string): boolean => /(^|\s)@astra\b/i.test(text)

/** The commit message after its headline: a Guide step's why. */
export function commitWhy(message: string): string {
  return message.split('\n').slice(1).join('\n').trim()
}
