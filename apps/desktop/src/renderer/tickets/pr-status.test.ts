import { describe, expect, it } from 'vitest'
import type { ReviewPr } from '@evaos/contract'
import type { TicketPrFacts } from '@relay/protocol'
import {
  mergeOfferOf,
  prSignalsOf,
  prSignalsOfReview,
  prStatusOf,
  type PrSignals,
} from './pr-status'

const signals = (mergeState: string | null, over: Partial<PrSignals> = {}): PrSignals => ({
  state: 'open',
  checks: 'pass',
  counts: { passed: 2, failed: 0, pending: 0 },
  decision: 'APPROVED',
  mergeState,
  ...over,
})

describe('prStatusOf by mergeStateStatus', () => {
  it.each([
    ['BLOCKED', 'Blocked: Required reviews or checks are missing', 'bad', null, 'No conflicts'],
    ['BEHIND', 'Blocked: Behind the base branch', 'bad', null, 'No conflicts'],
    ['DIRTY', 'Blocked: Conflicts', 'bad', null, 'Conflicts with the base branch'],
    [
      'UNSTABLE',
      'Ready to merge',
      'ok',
      'Some checks aren’t passing; GitHub still allows the merge',
      'No conflicts',
    ],
    ['DRAFT', 'Blocked: Draft', 'bad', null, 'No conflicts'],
    ['CLEAN', 'Ready to merge', 'ok', null, 'No conflicts'],
    [
      'HAS_HOOKS',
      'Ready to merge',
      'ok',
      'The repository runs hooks when it merges',
      'No conflicts',
    ],
    [
      'UNKNOWN',
      'Checking whether it can merge',
      'dim',
      'GitHub is still working out whether it can merge',
      'No conflicts',
    ],
  ])('%s reads "%s"', (state, line, tone, note, conflicts) => {
    expect(prStatusOf(signals(state))).toMatchObject({ line, tone, note, conflicts })
  })

  it('names failing checks before branch rules, and says nothing more once merged', () => {
    const failing = signals('BLOCKED', {
      checks: 'fail',
      counts: { passed: 1, failed: 1, pending: 0 },
    })
    expect(prStatusOf(failing).line).toBe('Blocked: 1 failing check')
    expect(prStatusOf(signals('UNKNOWN', { state: 'merged' }))).toMatchObject({
      line: 'Merged',
      note: null,
      conflicts: null,
    })
  })
})

const SHA = 'a'.repeat(40)
const ACTIONS: NonNullable<ReviewPr['actions']> = {
  viewerLogin: 'webdevike',
  viewerPermission: 'WRITE',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  methods: { merge: true, squash: true, rebase: false },
  mergeQueue: { required: false, inQueue: false, entryState: null },
  reviews: [{ login: 'noah', state: 'APPROVED', at: 1 }],
  checks: [
    {
      name: 'test',
      state: 'pass',
      url: null,
      workflow: 'CI',
      runId: 7,
      runNumber: 1,
      attempt: null,
      headSha: SHA,
    },
    {
      name: 'old',
      state: 'skipped',
      url: null,
      workflow: null,
      runId: null,
      runNumber: null,
      attempt: null,
      headSha: SHA,
    },
  ],
}

const prOf = (
  actions: Partial<NonNullable<ReviewPr['actions']>> | null,
  over: Partial<ReviewPr> = {},
) =>
  ({
    repo: 'o/r',
    number: 1,
    state: 'OPEN',
    draft: false,
    base: 'main',
    headSha: SHA,
    reviewers: [],
    checks: [],
    ...(actions ? { actions: { ...ACTIONS, ...actions } } : {}),
    ...over,
  }) as unknown as ReviewPr

describe('mergeOfferOf', () => {
  it('hides the merge box without the host’s actions facts', () => {
    expect(mergeOfferOf(prOf(null))).toEqual({ kind: 'hidden' })
    expect(mergeOfferOf(prOf({}, { headSha: undefined }))).toEqual({ kind: 'hidden' })
  })

  it('offers Merge now with the allowed methods only when GitHub merges it right now', () => {
    expect(mergeOfferOf(prOf({}))).toEqual({ kind: 'offer', methods: ['merge', 'squash'] })
    expect(mergeOfferOf(prOf({ mergeStateStatus: 'UNSTABLE' }))).toMatchObject({ kind: 'offer' })
  })

  it('never offers auto-merge or a merge queue: says why it can’t merge now', () => {
    const reason = (pr: ReviewPr) => {
      const o = mergeOfferOf(pr)
      return o.kind === 'none' ? o.reason : o.kind
    }
    expect(reason(prOf({ mergeStateStatus: 'BLOCKED' }))).toBe(
      'Required reviews or checks are missing',
    )
    expect(reason(prOf({ mergeStateStatus: 'BEHIND' }))).toBe('Behind the base branch')
    expect(reason(prOf({ mergeStateStatus: 'UNKNOWN' }))).toBe(
      'GitHub is still working out whether it can merge',
    )
    const queue = { required: true, inQueue: false, entryState: null }
    expect(reason(prOf({ mergeQueue: queue }))).toBe(
      'This branch merges through a merge queue: add it on GitHub',
    )
  })

  it('says why there is nothing to merge', () => {
    const reason = (pr: ReviewPr) => {
      const o = mergeOfferOf(pr)
      return o.kind === 'none' ? o.reason : o.kind
    }
    expect(reason(prOf({}, { state: 'MERGED' }))).toBe('Merged')
    expect(reason(prOf({}, { draft: true }))).toBe('Draft: mark it ready for review first')
    expect(reason(prOf({ viewerPermission: 'READ' }))).toBe('You can’t merge in this repository')
    expect(reason(prOf({ methods: { merge: false, squash: false, rebase: false } }))).toBe(
      'The repository allows no merge method',
    )
    expect(reason(prOf({ mergeStateStatus: 'DIRTY' }))).toBe(
      'Conflicts with main: resolve them first',
    )
    const inQueue = { required: true, inQueue: true, entryState: 'QUEUED' }
    expect(reason(prOf({ mergeQueue: inQueue }))).toBe('In the merge queue')
  })

  it('ignores an auto-merge fact an older host still sends', () => {
    const older = { autoMerge: { method: 'squash', by: 'iweber' } } as Partial<
      NonNullable<ReviewPr['actions']>
    >
    expect(mergeOfferOf(prOf(older))).toEqual({ kind: 'offer', methods: ['merge', 'squash'] })
  })
})

describe('prSignalsOfReview', () => {
  it('reads the host’s checks (skipped left out), latest reviews and merge state', () => {
    expect(prSignalsOfReview(prOf({ mergeStateStatus: 'BEHIND' }))).toEqual({
      state: 'open',
      checks: 'pass',
      counts: { passed: 1, failed: 0, pending: 0 },
      decision: 'APPROVED',
      mergeState: 'BEHIND',
    })
  })

  it('falls back to the read’s checks and reviewers without host facts', () => {
    const pr = prOf(null, {
      draft: true,
      checks: [{ name: 'a', state: 'fail', url: null }],
      reviewers: [{ login: 'x', state: 'CHANGES_REQUESTED' }],
    })
    expect(prSignalsOfReview(pr)).toMatchObject({
      state: 'draft',
      checks: 'fail',
      decision: 'CHANGES_REQUESTED',
      mergeState: null,
    })
  })

  it('says what the ticket’s facts say for the same PR, from GitHub’s review decision', () => {
    // One PR waiting on a required review: GitHub's BLOCKED, checks green, nobody reviewed yet.
    const facts: TicketPrFacts = {
      repo: 'o/r',
      number: 1,
      title: 't',
      url: 'https://github.com/o/r/pull/1',
      author: 'isaac',
      state: 'open',
      draft: false,
      checks: { state: 'pass', passed: 1, failed: 0, pending: 0 },
      decision: 'REVIEW_REQUIRED',
      mergeState: 'BLOCKED',
      headSha: SHA,
      updatedAt: 1,
    }
    const ref = { repo: 'o/r', number: 1, url: facts.url, title: null, state: 'open' as const }
    const ticketLine = prStatusOf(prSignalsOf({ ...ref, via: 'linear' }, [facts], null)).line
    const blocked = { mergeStateStatus: 'BLOCKED', reviews: [] }
    const readLine = prStatusOf(
      prSignalsOfReview(prOf(blocked, { reviewDecision: 'REVIEW_REQUIRED' })),
    ).line
    expect(ticketLine).toBe('Blocked: Waiting on review')
    expect(readLine).toBe(ticketLine)
    // An older host sends no decision: today's merge-state wording.
    expect(prStatusOf(prSignalsOfReview(prOf(blocked))).line).toBe(
      'Blocked: Required reviews or checks are missing',
    )
  })
})
