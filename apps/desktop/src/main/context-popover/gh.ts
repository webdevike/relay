// Pull request facts for the context popover, from `gh pr view --json`. Fetched in the
// background through a BackgroundCache; a snapshot never waits on gh.
import { z } from 'zod'

export interface PrFacts {
  repo: string
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null. */
  decision: string | null
  base: string
  head: string
  additions: number
  deletions: number
  checks: { passed: number; failed: number; pending: number; total: number }
  /** Each reviewer's latest review that says something (approved, changes requested, commented). */
  reviews: Array<{ login: string; state: string; at: number | null }>
}

const Check = z
  .object({
    __typename: z.string().optional(),
    status: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
  })
  .passthrough()

const PrJson = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  reviewDecision: z.string().nullable().optional(),
  baseRefName: z.string(),
  headRefName: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  statusCheckRollup: z.array(Check).nullable().optional(),
  latestReviews: z
    .array(
      z.object({
        author: z.object({ login: z.string() }).nullable(),
        state: z.string(),
        submittedAt: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
})

export const PR_FIELDS =
  'number,title,url,state,isDraft,reviewDecision,baseRefName,headRefName,additions,deletions,statusCheckRollup,latestReviews'

const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

/** `gh pr view --json PR_FIELDS` output as facts; null when it is not that shape. */
export function parsePr(repo: string, stdout: string): PrFacts | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  const r = PrJson.safeParse(raw)
  if (!r.success) return null
  const p = r.data
  const checks = { passed: 0, failed: 0, pending: 0, total: 0 }
  for (const c of p.statusCheckRollup ?? []) {
    // CheckRun: status + conclusion; StatusContext: state.
    const verdict = (c.conclusion || c.state || '').toUpperCase()
    const done = c.status == null || c.status.toUpperCase() === 'COMPLETED'
    checks.total++
    if (!done || verdict === 'PENDING' || verdict === 'EXPECTED' || verdict === '') checks.pending++
    else if (PASSED.includes(verdict)) checks.passed++
    else if (FAILED.includes(verdict)) checks.failed++
    else checks.pending++
  }
  const reviews = (p.latestReviews ?? [])
    .filter((v) => v.author !== null && v.state !== 'PENDING' && v.state !== 'DISMISSED')
    .map((v) => {
      const at = v.submittedAt ? Date.parse(v.submittedAt) : NaN
      return { login: v.author!.login, state: v.state, at: Number.isNaN(at) ? null : at }
    })
  return {
    repo,
    number: p.number,
    title: p.title,
    url: p.url,
    state: p.state,
    draft: p.isDraft,
    decision: p.reviewDecision || null,
    base: p.baseRefName,
    head: p.headRefName,
    additions: p.additions,
    deletions: p.deletions,
    checks,
    reviews,
  }
}

/** Runs `gh` with these arguments (main passes the app's PATH; tests a fake). */
export type GhRun = (args: string[]) => Promise<{ code: number | null; stdout: string }>

/** One PR's facts from gh, or null when gh fails or answers something else. */
export async function fetchPr(run: GhRun, repo: string, number: number): Promise<PrFacts | null> {
  const r = await run(['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS])
  return r.code === 0 ? parsePr(repo, r.stdout) : null
}
