// A PR's checks and the queue row's pills, from gh's JSON: the local `gh pr view`, or the Mini's
// `prView` answer in remote mode (the same fields).
import { z } from 'zod'
import type { ReviewRowStatus } from '@evaos/contract'

const PASSED = ['SUCCESS', 'NEUTRAL']
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

export interface RawCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string | null
  conclusion?: string | null
  state?: string | null
  detailsUrl?: string | null
  targetUrl?: string | null
}

/** pass, fail, pending or skipped. */
export function checkState(c: RawCheck): string {
  const v = (c.conclusion || c.state || '').toUpperCase()
  if (v === 'SKIPPED') return 'skipped'
  if (PASSED.includes(v)) return 'pass'
  if (FAILED.includes(v)) return 'fail'
  return 'pending'
}

const RowJson = z.object({
  isDraft: z.boolean(),
  reviewDecision: z.string().nullable().optional(),
  statusCheckRollup: z
    .array(
      z.object({
        conclusion: z.string().nullable().optional(),
        state: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
})

/** `gh pr view --json statusCheckRollup,reviewDecision,isDraft` (or more) as the row's pills; null when it is not that shape. */
export function rowStatusOf(json: unknown): ReviewRowStatus | null {
  const v = RowJson.safeParse(json)
  if (!v.success) return null
  const states = (v.data.statusCheckRollup ?? []).map(checkState).filter((s) => s !== 'skipped')
  const ci = !states.length
    ? ('none' as const)
    : states.includes('fail')
      ? ('fail' as const)
      : states.includes('pending')
        ? ('pending' as const)
        : ('pass' as const)
  const decision = (['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const).find(
    (d) => d === v.data.reviewDecision,
  )
  return { draft: v.data.isDraft, ci, decision: decision ?? null }
}
