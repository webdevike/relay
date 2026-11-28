// One pull request's status in words, from whatever facts the page has: the host's PR facts
// (checks with counts, review decision, merge state), else the synced card's (checks rollup,
// decision), else only the PR's state. The status strip and, later, the PR sidebar read it.
import type { AgentCard } from '@evaos/contract'
import type { TicketPrFacts } from '@relay/protocol'
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

const STATE_WORD: Record<NonNullable<TicketPr['state']>, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
}

/** The first thing that keeps it from merging, in the order Isaac would fix them. */
const BLOCKERS: ReadonlyArray<(s: PrSignals) => string | null> = [
  (s) => (s.state === 'closed' ? 'Closed without merging' : null),
  (s) => (s.state === 'draft' ? 'Draft' : null),
  (s) => (s.mergeState === 'DIRTY' ? 'Conflicts' : null),
  (s) => (s.checks === 'fail' ? failingWords(s) : null),
  (s) => (s.decision === 'CHANGES_REQUESTED' ? 'Changes requested' : null),
  (s) => (s.checks === 'pending' ? 'Checks running' : null),
  (s) => (s.decision === 'REVIEW_REQUIRED' ? 'Waiting on review' : null),
  (s) => (s.mergeState === 'BEHIND' ? 'Behind the base branch' : null),
  (s) => (s.mergeState === 'BLOCKED' ? 'Branch rules' : null),
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
  // Nothing beyond its state is known (no host facts, no checks): readiness can't be told.
  if (s.checks === null && s.decision === null && s.mergeState === null)
    return { line: STATE_WORD[s.state ?? 'open'], tone: 'dim' }
  return { line: 'Ready to merge', tone: 'ok' }
}

export function prStatusOf(s: PrSignals): PrStatus {
  const blocked =
    s.state === 'merged' ? null : (BLOCKERS.map((b) => b(s)).find((w) => w !== null) ?? null)
  return {
    state: STATE_WORD[s.state ?? 'open'],
    blocked,
    ...lineOf(s, blocked),
    checks: checksWords(s),
    conflicts: conflictWords(s),
  }
}
