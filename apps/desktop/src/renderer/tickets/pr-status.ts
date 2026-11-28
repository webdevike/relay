// One pull request's status in words, from whatever facts the page has: the host's PR facts
// (checks with counts, review decision, merge state), else the synced card's (checks rollup,
// decision), else only the PR's state; on the PR page, the PR read itself (`prSignalsOfReview`).
// The ticket page's status strip and the PR sidebar both read `prStatusOf`, the strip through
// `prSignalsFor` so a PR's page says the same words in both. The merge box reads `mergeOfferOf`:
// the one Merge now button (PLAN §2.6), or why GitHub won't merge it right now.
import type { AgentCard, ReviewPr } from '@evaos/contract'
import type { PrMergeMethod, TicketPrFacts } from '@relay/protocol'
import type { TicketPr } from '../agents-board/ticket-prs'
import { samePr } from './ticket-data'

type Checks = 'pass' | 'fail' | 'pending' | 'none'

export interface PrSignals {
  state: TicketPr['state']
  checks: Checks | null
  counts: { passed: number; failed: number; pending: number } | null
  decision: string | null
  /** GitHub `mergeStateStatus`; null when unknown. */
  mergeState: string | null
}

export interface PrStatus {
  /** `Open`, `Draft`, `Merged`, `Closed`. */
  state: string
  /** Why it can't merge yet; null when it can (or it's merged). */
  blocked: string | null
  /** `Merged`, `Ready to merge`, or `Blocked: <why>`. */
  line: string
  tone: 'ok' | 'bad' | 'dim'
  checks: string
  /** Null when the merge state isn't known. */
  conflicts: string | null
  /** What else GitHub's merge state says when nothing blocks it (failing optional checks, hooks, still computing). */
  note: string | null
}

/**
 * GitHub's `mergeStateStatus` in plain words: what keeps the PR from merging, or a note when it can
 * go (or GitHub can't tell yet).
 */
export const MERGE_STATE_WORDS: Readonly<
  Record<string, { blocked: string | null; note: string | null }>
> = {
  BLOCKED: { blocked: 'Required reviews or checks are missing', note: null },
  BEHIND: { blocked: 'Behind the base branch', note: null },
  DIRTY: { blocked: 'Conflicts', note: null },
  DRAFT: { blocked: 'Draft', note: null },
  UNSTABLE: { blocked: null, note: 'Some checks aren’t passing; GitHub still allows the merge' },
  CLEAN: { blocked: null, note: null },
  HAS_HOOKS: { blocked: null, note: 'The repository runs hooks when it merges' },
  UNKNOWN: { blocked: null, note: 'GitHub is still working out whether it can merge' },
}

function signalsOfFacts(f: TicketPrFacts): PrSignals {
  const { passed, failed, pending } = f.checks
  return {
    state: f.state === 'open' && f.draft ? 'draft' : f.state,
    checks: f.checks.state,
    counts: { passed, failed, pending },
    decision: f.decision,
    mergeState: f.mergeState,
  }
}

/** The synced card's own view of `pr`: one of its ticket's PRs, else the agent's PR. */
function cardPrOf(card: AgentCard | null, pr: TicketPr): AgentCard['pr'] | null {
  if (card === null) return null
  const synced = card.ticket?.prs.find((x) => samePr(x, pr))
  if (synced) return synced
  return card.pr && samePr(card.pr, pr) ? card.pr : null
}

/** The signals the page knows for `pr`. */
export function prSignalsOf(
  pr: TicketPr,
  facts: readonly TicketPrFacts[],
  card: AgentCard | null,
): PrSignals {
  const f = facts.find((x) => samePr(x, pr))
  if (f) return signalsOfFacts(f)
  const c = cardPrOf(card, pr)
  return {
    state: pr.state ?? c?.state ?? null,
    checks: c?.checks ?? null,
    counts: null,
    decision: c?.decision ?? null,
    mergeState: null,
  }
}

function reviewStateOf(pr: ReviewPr): TicketPr['state'] {
  if (pr.state === 'MERGED') return 'merged'
  if (pr.state === 'CLOSED') return 'closed'
  return pr.draft ? 'draft' : 'open'
}

/** The rollup of check states: fail beats pending beats pass; none when nothing ran. */
function rollupOf(states: readonly string[]): Checks {
  if (states.length === 0) return 'none'
  if (states.includes('fail')) return 'fail'
  return states.includes('pending') ? 'pending' : 'pass'
}

/** The latest reviews' verdict: changes requested wins, then approved; null when nobody decided. */
function decisionOf(reviews: readonly { state: string }[]): string | null {
  if (reviews.some((r) => r.state === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED'
  return reviews.some((r) => r.state === 'APPROVED') ? 'APPROVED' : null
}

/**
 * The signals of a PR read (the PR page): its checks, GitHub's review decision (else the latest
 * reviews' verdict, from older hosts) and, from the host, its merge state.
 */
export function prSignalsOfReview(pr: ReviewPr): PrSignals {
  const checks = pr.actions?.checks ?? pr.checks
  const states = checks.map((c) => c.state).filter((s) => s !== 'skipped')
  const count = (s: string): number => states.filter((x) => x === s).length
  return {
    state: reviewStateOf(pr),
    checks: rollupOf(states),
    counts: { passed: count('pass'), failed: count('fail'), pending: count('pending') },
    decision: pr.reviewDecision ?? decisionOf(pr.actions?.reviews ?? pr.reviewers),
    mergeState: pr.actions?.mergeStateStatus ?? null,
  }
}

/**
 * The signals the ticket's strip shows for `pr`: the PR page's own read when it is of `pr` (what
 * its sidebar reads, so both say the same), else the ticket's facts.
 */
export function prSignalsFor(
  pr: TicketPr,
  facts: readonly TicketPrFacts[],
  card: AgentCard | null,
  read: ReviewPr | null,
): PrSignals {
  return read && samePr(read, pr) ? prSignalsOfReview(read) : prSignalsOf(pr, facts, card)
}

const STATE_WORD: Record<NonNullable<TicketPr['state']>, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
}

const mergeBlock = (s: PrSignals, status: string): string | null =>
  s.mergeState === status ? (MERGE_STATE_WORDS[status]?.blocked ?? null) : null

/** The first thing that keeps it from merging, in the order Isaac would fix them. */
const BLOCKERS: ReadonlyArray<(s: PrSignals) => string | null> = [
  (s) => (s.state === 'closed' ? 'Closed without merging' : null),
  (s) => (s.state === 'draft' ? 'Draft' : mergeBlock(s, 'DRAFT')),
  (s) => mergeBlock(s, 'DIRTY'),
  (s) => (s.checks === 'fail' ? failingWords(s) : null),
  (s) => (s.decision === 'CHANGES_REQUESTED' ? 'Changes requested' : null),
  (s) => (s.checks === 'pending' ? 'Checks running' : null),
  (s) => (s.decision === 'REVIEW_REQUIRED' ? 'Waiting on review' : null),
  (s) => mergeBlock(s, 'BEHIND'),
  (s) => mergeBlock(s, 'BLOCKED'),
]

function failingWords(s: PrSignals): string {
  const n = s.counts?.failed ?? 0
  return n > 1 ? `${n} failing checks` : n === 1 ? '1 failing check' : 'Failing checks'
}

function checksWords(s: PrSignals): string {
  if (s.checks === null) return 'Checks unknown'
  if (s.checks === 'none') return 'No checks'
  const c = s.counts
  if (c === null)
    return { pass: 'Checks passing', fail: 'Checks failing', pending: 'Checks running' }[s.checks]
  const total = c.passed + c.failed + c.pending
  return `${c.passed}/${total} checks passing`
}

function conflictWords(s: PrSignals): string | null {
  if (s.mergeState === null || s.state === 'merged') return null
  return s.mergeState === 'DIRTY' ? 'Conflicts with the base branch' : 'No conflicts'
}

function lineOf(s: PrSignals, blocked: string | null): Pick<PrStatus, 'line' | 'tone'> {
  if (s.state === 'merged') return { line: 'Merged', tone: 'dim' }
  if (blocked) return { line: `Blocked: ${blocked}`, tone: 'bad' }
  if (s.mergeState === 'UNKNOWN') return { line: 'Checking whether it can merge', tone: 'dim' }
  // Nothing beyond its state is known (no host facts, no checks): readiness can't be told.
  if (s.checks === null && s.decision === null && s.mergeState === null)
    return { line: STATE_WORD[s.state ?? 'open'], tone: 'dim' }
  return { line: 'Ready to merge', tone: 'ok' }
}

export function prStatusOf(s: PrSignals): PrStatus {
  const blocked =
    s.state === 'merged' ? null : (BLOCKERS.map((b) => b(s)).find((w) => w !== null) ?? null)
  const open = s.state !== 'merged' && s.state !== 'closed'
  return {
    state: STATE_WORD[s.state ?? 'open'],
    blocked,
    ...lineOf(s, blocked),
    checks: checksWords(s),
    conflicts: conflictWords(s),
    note: open && blocked === null ? (MERGE_STATE_WORDS[s.mergeState ?? '']?.note ?? null) : null,
  }
}

// ---- The merge box's one button (PLAN §2.6) ----

export type MergeOffer =
  /** No write controls: the host gave no actions facts (old host, local mode, GitHub couldn't say). */
  | { kind: 'hidden' }
  /** Nothing to merge now, and why. Relay never defers a merge (no auto-merge, no merge queue). */
  | { kind: 'none'; reason: string }
  /** Merge now, exactly the head the page shows; the repository's allowed methods, in GitHub's order. */
  | { kind: 'offer'; methods: PrMergeMethod[] }

const METHODS: readonly PrMergeMethod[] = ['merge', 'squash', 'rebase']
const WRITERS: Record<string, true> = { ADMIN: true, MAINTAIN: true, WRITE: true }
const MERGES_NOW: Record<string, true> = { CLEAN: true, HAS_HOOKS: true, UNSTABLE: true }

type Actions = NonNullable<ReviewPr['actions']>

/** Why there is no merge button, in the order Isaac would see it on GitHub; null when there is one. */
const NO_MERGE: ReadonlyArray<(pr: ReviewPr, a: Actions) => string | null> = [
  (pr) => (pr.state === 'MERGED' ? 'Merged' : null),
  (pr) => (pr.state === 'CLOSED' ? 'Closed without merging' : null),
  (_, a) => (a.mergeQueue.inQueue ? 'In the merge queue' : null),
  (pr, a) =>
    pr.draft || a.mergeStateStatus === 'DRAFT' ? 'Draft: mark it ready for review first' : null,
  (_, a) =>
    a.viewerPermission !== null && WRITERS[a.viewerPermission]
      ? null
      : 'You can’t merge in this repository',
  (_, a) => (METHODS.some((m) => a.methods[m]) ? null : 'The repository allows no merge method'),
  (pr, a) =>
    a.mergeStateStatus === 'DIRTY' ? `Conflicts with ${pr.base}: resolve them first` : null,
  (_, a) =>
    a.mergeQueue.required ? 'This branch merges through a merge queue: add it on GitHub' : null,
  (_, a) => {
    const s = a.mergeStateStatus
    if (MERGES_NOW[s]) return null
    return (
      MERGE_STATE_WORDS[s]?.blocked ?? MERGE_STATE_WORDS[s]?.note ?? 'GitHub won’t merge it yet'
    )
  },
]

/** What the merge box offers for `pr`: hidden without host facts, a reason, or Merge now. */
export function mergeOfferOf(pr: ReviewPr): MergeOffer {
  const a = pr.actions
  if (a === undefined || pr.headSha === undefined) return { kind: 'hidden' }
  const reason = NO_MERGE.map((r) => r(pr, a)).find((w) => w !== null)
  if (reason) return { kind: 'none', reason }
  return { kind: 'offer', methods: METHODS.filter((m) => a.methods[m]) }
}
