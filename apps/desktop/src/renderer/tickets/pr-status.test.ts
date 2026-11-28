import { describe, expect, it } from 'vitest'
import type { ReviewPr } from '@evaos/contract'
import { mergeOfferOf, prSignalsOfReview, prStatusOf, type PrSignals } from './pr-status'

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
  autoMerge: null,
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

  it('offers one outcome with the allowed methods', () => {
    expect(mergeOfferOf(prOf({}))).toEqual({
      kind: 'offer',
      intent: 'merge',
      outcome: 'Merge now',
      effect: 'merge',
      methods: ['merge', 'squash'],
    })
    expect(mergeOfferOf(prOf({ mergeStateStatus: 'BLOCKED' }))).toMatchObject({
      intent: 'auto',
      outcome: 'Turn on auto-merge',
      effect: 'auto',
    })
    const queue = { required: true, inQueue: false, entryState: null }
    expect(mergeOfferOf(prOf({ mergeQueue: queue }))).toMatchObject({
      intent: 'auto',
      outcome: 'Add to merge queue',
      effect: 'queue',
    })
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

  it('shows an armed auto-merge, never --admin', () => {
    expect(mergeOfferOf(prOf({ autoMerge: { method: 'squash', by: 'iweber' } }))).toEqual({
      kind: 'armed',
      method: 'squash',
      by: 'iweber',
    })
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
})
