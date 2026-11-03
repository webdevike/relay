import { useEffect, useState } from 'react'
import type { ReviewRow, ReviewRowStatus, ReviewWork } from '@evaos/contract'
import { invoke } from '../ipc'
import { prKey } from './review-model'

/** What a PR row's pills are built from: GitHub's CI and decision, and Astra's ledger and loop. */
export interface RowStatus {
  github: ReviewRowStatus | null
  work: ReviewWork | null
}

/** Astra's self-review loop stops after this many reviews (jobs/astra-auto-work MAX_REVIEWS). */
export const MAX_SELF_REVIEWS = 3
/** The ledger and loop move on their own, so the list reads them again this often. */
const WORK_POLL_MS = 10_000
const WORKERS = 3

export interface Pill {
  label: string
  tone: 'green' | 'red' | 'amber' | 'violet' | 'gray'
  testId?: string
}

const CI_PILL = {
  pass: { label: 'CI passing', tone: 'green' },
  fail: { label: 'CI failing', tone: 'red' },
  pending: { label: 'CI running', tone: 'amber' },
} as const

/**
 * The pills of a PR row, in order: Draft, CI, Approve ready, then where the work stands: the
 * self-review loop, Approved, Changes requested, In review or Ready for review. Quiet by design:
 * a PR auto-work did not open shows only what GitHub says.
 */
export function rowPills(row: Pick<ReviewRow, 'draft'>, s: RowStatus | undefined): Pill[] {
  const pills: Pill[] = []
  if (row.draft) pills.push({ label: 'Draft', tone: 'gray' })
  const ci = s?.github?.ci
  if (ci && ci !== 'none') pills.push({ ...CI_PILL[ci], testId: 'review-row-ci' })
  const work = s?.work
  if (work?.approve === 'ready') {
    pills.push({ label: 'Approve ready', tone: 'violet', testId: 'review-row-approve' })
  }
  const loop = work?.loop
  if (loop?.running) {
    pills.push({
      label: loop.rounds > 0 ? `Self-review ${loop.rounds}/${MAX_SELF_REVIEWS}` : 'Self-review',
      tone: 'violet',
      testId: 'review-row-work',
    })
  } else if (work?.approve === 'sent') {
    pills.push({ label: 'Approved', tone: 'green', testId: 'review-row-work' })
  } else if (!row.draft) {
    const decision = s?.github?.decision
    const label =
      decision === 'APPROVED'
        ? 'Approved'
        : decision === 'CHANGES_REQUESTED'
          ? 'Changes requested'
          : work?.phase === 'in-review'
            ? 'In review'
            : work
              ? 'Ready for review'
              : null
    if (label) {
      pills.push({
        label,
        tone: decision === 'APPROVED' ? 'green' : decision === 'CHANGES_REQUESTED' ? 'red' : 'gray',
        testId: 'review-row-work',
      })
    }
  }
  return pills
}

// CI and the review decision change only when the PR does: read once per update. The work state
// comes from local ledgers (or the Mini's host), so it is read again on a timer and on demand.
const githubCache = new Map<string, ReviewRowStatus | null>()
const workCache = new Map<string, ReviewWork | null>()
const listeners = new Set<() => void>()
const refreshers = new Set<() => void>()

const githubKey = (r: ReviewRow): string => `${prKey(r)}@${r.updatedAt}`

/** Reads every visible row's work state again now (after Approve), so the list changes at once. */
export function refreshRowStatus(): void {
  for (const f of refreshers) f()
}

async function readWork(r: ReviewRow): Promise<void> {
  const res = await invoke('reviews.work', { repo: r.repo, number: r.number })
  workCache.set(prKey(r), res.ok ? res.value : null)
}

async function readGithub(r: ReviewRow): Promise<void> {
  const res = await invoke('reviews.rowStatus', { repo: r.repo, number: r.number })
  githubCache.set(githubKey(r), res.ok ? res.value : null)
}

/** Runs `job` over `rows`, `WORKERS` at a time, telling the hook after each. */
async function pool(
  rows: ReviewRow[],
  job: (r: ReviewRow) => Promise<void>,
  alive: () => boolean,
): Promise<void> {
  const todo = [...rows]
  const worker = async (): Promise<void> => {
    for (let r = todo.shift(); alive() && r; r = todo.shift()) {
      await job(r)
      if (alive()) for (const l of listeners) l()
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker))
}

/** Statuses for `rows`: CI and decision once per PR update, the work state live. */
export function useRowStatus(rows: ReviewRow[]): Record<string, RowStatus> {
  const [, bump] = useState(0)
  const wanted = rows.map(githubKey).join('|')
  useEffect(() => {
    const on = (): void => bump((n) => n + 1)
    listeners.add(on)
    return () => {
      listeners.delete(on)
    }
  }, [])
  useEffect(() => {
    let live = true
    const alive = (): boolean => live
    void pool(
      rows.filter((r) => !githubCache.has(githubKey(r))),
      readGithub,
      alive,
    )
    const refreshWork = (): void => void pool(rows, readWork, alive)
    refreshWork()
    refreshers.add(refreshWork)
    const t = setInterval(refreshWork, WORK_POLL_MS)
    return () => {
      live = false
      refreshers.delete(refreshWork)
      clearInterval(t)
    }
    // `wanted` is the rows' identity; the rows array itself is new every render.
  }, [wanted])
  return Object.fromEntries(
    rows.map((r) => [
      githubKey(r),
      { github: githubCache.get(githubKey(r)) ?? null, work: workCache.get(prKey(r)) ?? null },
    ]),
  )
}

export const rowStatusKey = githubKey
