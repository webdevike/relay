import { describe, expect, it, vi, type Mock } from 'vitest'
import { createActor, fromPromise, waitFor } from 'xstate'
import type { TicketMutation, TicketOutcome } from '@relay/protocol'
import {
  applyRows,
  checkRows,
  NEEDS_NEWER_HOST,
  OTHER_ACCOUNT,
  OTHER_ROWS,
  replanRows,
  type PlanDeps,
} from './plan-actor'
import type { DraftRow, PlanTicket } from './plan-rules'
import {
  STALE_ROW,
  timelinePlanMachine,
  UNREADABLE_PLAN,
  type ApplyInput,
  type ApplyOutput,
  type ReplanOutput,
  type ReplanScope,
} from './plan.machine'

const T0 = Date.UTC(2026, 10, 20, 12)
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const SCOPE: ReplanScope = { projectId: 'p1', milestoneId: 'm1', label: 'Relay Board / Board v1' }
const BASE = { dueDate: '2026-12-05', priority: 2, prioritySortOrder: 1, plannedStart: null }
const ME = 'user-me'

function row(key: string, n: number, over: Partial<DraftRow> = {}): DraftRow {
  return {
    key,
    issueId: `issue-${key}`,
    opId: uuid(n),
    baseUpdatedAt: T0,
    base: BASE,
    dueDate: '2026-12-09',
    ...over,
  }
}

const allDone = (input: ApplyInput): ApplyOutput => ({
  kind: 'done',
  results: input.rows.map((r) => ({ key: r.key, state: 'done' })),
})

function start(
  over: {
    replan?: (scope: ReplanScope) => Promise<ReplanOutput>
    apply?: (input: ApplyInput, call: number) => Promise<ApplyOutput>
    check?: (input: ApplyInput, call: number) => Promise<ApplyOutput>
  } = {},
) {
  const applied: ApplyInput[] = []
  const checked: ApplyInput[] = []
  const replans: ReplanScope[] = []
  const machine = timelinePlanMachine.provide({
    actors: {
      replan: fromPromise<ReplanOutput, ReplanScope>(async ({ input }) => {
        replans.push(input)
        return over.replan ? over.replan(input) : null
      }),
      apply: fromPromise<ApplyOutput, ApplyInput>(async ({ input }) => {
        applied.push(structuredClone(input))
        return over.apply ? over.apply(input, applied.length) : allDone(input)
      }),
      check: fromPromise<ApplyOutput, ApplyInput>(async ({ input }) => {
        checked.push(structuredClone(input))
        return over.check ? over.check(input, checked.length) : allDone(input)
      }),
    },
  })
  const actor = createActor(machine).start()
  const settle = (state: string) => waitFor(actor, (s) => s.matches(state as 'viewing'))
  const confirm = (): void => {
    actor.send({ type: 'plan.apply' })
    actor.send({ type: 'plan.confirm' })
  }
  return { actor, applied, checked, replans, settle, confirm }
}

describe('timelinePlanMachine', () => {
  it('writes nothing until Apply is confirmed', async () => {
    const { actor, applied, settle } = start()
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1)] })
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1), row('ENG-2', 2)] })
    expect(actor.getSnapshot().value).toBe('drafting')
    actor.send({ type: 'plan.apply' })
    expect(actor.getSnapshot().value).toBe('confirming')
    actor.send({ type: 'plan.back' })
    expect(actor.getSnapshot().value).toBe('drafting')
    expect(applied).toEqual([])
    actor.send({ type: 'plan.apply' })
    actor.send({ type: 'plan.confirm' })
    await settle('applied')
    expect(applied).toHaveLength(1)
    expect(applied[0]!.rows.map((r) => r.opId)).toEqual([uuid(1), uuid(2)])
    expect(actor.getSnapshot().context.rows).toEqual([])
  })

  it('Discard clears a manual draft and an Astra proposal', async () => {
    const { actor, settle } = start({
      replan: async () => ({ rows: [row('ENG-3', 3, { reason: 'Earlier' })], summary: 'Tighter' }),
    })
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1)] })
    actor.send({ type: 'plan.discard' })
    expect(actor.getSnapshot().value).toBe('viewing')
    expect(actor.getSnapshot().context.rows).toEqual([])
    actor.send({ type: 'plan.replan', scope: SCOPE })
    await settle('reviewingProposal')
    expect(actor.getSnapshot().context).toMatchObject({ source: 'astra', summary: 'Tighter' })
    actor.send({ type: 'plan.discard' })
    expect(actor.getSnapshot().value).toBe('viewing')
    expect(actor.getSnapshot().context).toMatchObject({ rows: [], summary: null })
  })

  it('an edit that undoes every change goes back to viewing', () => {
    const { actor } = start()
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1)] })
    actor.send({ type: 'plan.edit', rows: [] })
    expect(actor.getSnapshot().value).toBe('viewing')
  })

  it('keeps definitely failed rows; a retry is a fresh confirm with a new batch, the rows keep their opIds', async () => {
    const { actor, applied, settle, confirm } = start({
      apply: async (input, call) =>
        call === 1
          ? {
              kind: 'done',
              results: [
                { key: 'ENG-1', state: 'done' },
                { key: 'ENG-2', state: 'failed', error: 'Linear said no' },
              ],
            }
          : allDone(input),
    })
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1), row('ENG-2', 2)] })
    confirm()
    await settle('partiallyFailed')
    expect(actor.getSnapshot().context.rows).toEqual([row('ENG-2', 2, { error: 'Linear said no' })])
    expect(actor.getSnapshot().context.batch).toBeNull()
    actor.send({ type: 'plan.retry' })
    expect(actor.getSnapshot().value).toBe('confirming')
    actor.send({ type: 'plan.confirm' })
    await settle('applied')
    expect(applied[1]!.rows.map((r) => [r.key, r.opId])).toEqual([['ENG-2', uuid(2)]])
    expect(applied[1]!.opId).not.toBe(applied[0]!.opId)
  })

  it('an unknown row keeps the whole batch as sent: no edit, no retry, only Check with the same commit', async () => {
    const { actor, applied, checked, settle, confirm } = start({
      apply: async () => ({
        kind: 'done',
        results: [
          { key: 'ENG-1', state: 'done' },
          { key: 'ENG-2', state: 'unknown', error: 'Lost' },
          { key: 'ENG-3', state: 'failed', error: 'No' },
        ],
      }),
      check: async (input) => allDone(input),
    })
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1), row('ENG-2', 2), row('ENG-3', 3)] })
    confirm()
    await settle('unknown')
    const snap = actor.getSnapshot()
    expect(snap.context.rows.map((r) => r.key)).toEqual(['ENG-2', 'ENG-3'])
    expect(snap.can({ type: 'plan.retry' })).toBe(false)
    expect(snap.can({ type: 'plan.edit', rows: [row('ENG-2', 9)] })).toBe(false)
    expect(snap.can({ type: 'plan.apply' })).toBe(false)
    actor.send({ type: 'plan.check' })
    await settle('applied')
    expect(applied).toHaveLength(1)
    expect(checked).toEqual([applied[0]])
  })

  it('a lost answer is unknown; a Check that stays unknown keeps the batch, then lands', async () => {
    const { actor, applied, checked, settle, confirm } = start({
      apply: async () => {
        throw new Error('Not connected to the Mini’s Relay Host.')
      },
      check: async (input, call) =>
        call === 1
          ? { kind: 'done', results: [{ key: 'ENG-1', state: 'unknown', error: 'Lost' }] }
          : allDone(input),
    })
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1)] })
    confirm()
    await settle('unknown')
    expect(actor.getSnapshot().context.message).toContain('Not connected')
    actor.send({ type: 'plan.check' })
    await settle('unknown')
    actor.send({ type: 'plan.check' })
    await settle('applied')
    expect(checked.map((c) => c.opId)).toEqual([applied[0]!.opId, applied[0]!.opId])
    expect(checked[1]).toEqual(applied[0])
  })

  it('a batch the host never got goes back to the confirm and is applied under the same batch opId', async () => {
    const { actor, applied, settle, confirm } = start({
      apply: async (input, call) => {
        if (call === 1) throw new Error('Host went away')
        return allDone(input)
      },
      check: async () => ({ kind: 'unsent' }),
    })
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1)] })
    confirm()
    await settle('unknown')
    actor.send({ type: 'plan.check' })
    await settle('confirming')
    actor.send({ type: 'plan.confirm' })
    await settle('applied')
    expect(applied[1]).toEqual(applied[0])
  })

  it('stale: nothing is confirmed until Isaac reviews the re-based draft', async () => {
    const { actor, applied, settle, confirm } = start({
      apply: async (input, call) =>
        call === 1 ? { kind: 'stale', keys: ['ENG-2'] } : allDone(input),
    })
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1), row('ENG-2', 2)] })
    confirm()
    await settle('stale')
    const rows = actor.getSnapshot().context.rows
    expect(rows[1]).toMatchObject({ stale: true, error: STALE_ROW })
    expect(actor.getSnapshot().can({ type: 'plan.confirm' })).toBe(false)
    expect(actor.getSnapshot().can({ type: 'plan.retry' })).toBe(false)
    const rebased = [row('ENG-1', 1), row('ENG-2', 2, { baseUpdatedAt: T0 + 5 })]
    actor.send({ type: 'plan.reconfirm', rows: rebased })
    expect(actor.getSnapshot().value).toBe('confirming')
    actor.send({ type: 'plan.confirm' })
    await settle('applied')
    expect(applied[1]!.rows).toEqual(rebased)
  })

  it('a proposal with stale rows is blocked until the fresh comparison is confirmed', async () => {
    const { actor, settle } = start({
      replan: async () => ({
        rows: [row('ENG-1', 1), row('ENG-2', 2, { stale: true })],
        summary: 's',
      }),
    })
    actor.send({ type: 'plan.replan', scope: SCOPE })
    await settle('stale')
    expect(actor.getSnapshot().context.rows[1]).toMatchObject({ stale: true, error: STALE_ROW })
    expect(actor.getSnapshot().can({ type: 'plan.apply' })).toBe(false)
    actor.send({ type: 'plan.reconfirm', rows: [row('ENG-1', 1), row('ENG-2', 2)] })
    expect(actor.getSnapshot().value).toBe('confirming')
  })

  it('an unreadable answer says so and leaves the draft as it was', async () => {
    const { actor, settle } = start({ replan: async () => null })
    actor.send({ type: 'plan.replan', scope: SCOPE })
    await settle('viewing')
    expect(actor.getSnapshot().context.message).toBe(UNREADABLE_PLAN)
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1)] })
    actor.send({ type: 'plan.replan', scope: SCOPE })
    await settle('drafting')
    expect(actor.getSnapshot().context).toMatchObject({
      message: UNREADABLE_PLAN,
      rows: [row('ENG-1', 1)],
    })
  })

  it('cancel stops waiting for Astra and keeps the draft', async () => {
    const { actor, replans } = start({ replan: () => new Promise<ReplanOutput>(() => {}) })
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1)] })
    actor.send({ type: 'plan.replan', scope: SCOPE })
    expect(actor.getSnapshot().value).toBe('replanning')
    await Promise.resolve()
    expect(replans).toEqual([SCOPE])
    actor.send({ type: 'plan.cancel' })
    expect(actor.getSnapshot().value).toBe('drafting')
    expect(actor.getSnapshot().context.rows).toEqual([row('ENG-1', 1)])
  })

  it('closing the confirm of a proposal returns to the proposal', async () => {
    const { actor, settle } = start({
      replan: async () => ({ rows: [row('ENG-3', 3)], summary: 's' }),
    })
    actor.send({ type: 'plan.replan', scope: SCOPE })
    await settle('reviewingProposal')
    actor.send({ type: 'plan.apply' })
    actor.send({ type: 'plan.back' })
    expect(actor.getSnapshot().value).toBe('reviewingProposal')
  })

  it('a refusal (writes off) keeps the draft with the reason', async () => {
    const { actor, settle, confirm } = start({
      apply: async () => ({ kind: 'refused', message: 'Writes are off on the host' }),
    })
    actor.send({ type: 'plan.edit', rows: [row('ENG-1', 1)] })
    confirm()
    await settle('drafting')
    expect(actor.getSnapshot().context).toMatchObject({
      message: 'Writes are off on the host',
      rows: [row('ENG-1', 1)],
    })
  })
})

function ticket(key: string, over: Partial<PlanTicket> = {}): PlanTicket {
  return {
    key,
    id: `issue-${key}`,
    title: key,
    state: { id: 's', name: 'Todo', type: 'unstarted', color: '#fff' },
    ...BASE,
    startedAt: null,
    updatedAt: T0,
    project: { id: 'p1', name: 'Relay Board', targetDate: null },
    milestone: { id: 'm1', name: 'Board v1', targetDate: null, sortOrder: 1 },
    ...over,
  }
}

function deps(over: Partial<PlanDeps> = {}): PlanDeps & {
  prepare: Mock
  commit: Mock
} {
  const outcome = (m: TicketMutation): TicketOutcome => ({
    opId: uuid(99),
    state: 'done',
    result: {
      rows:
        m.kind === 'applyPlan'
          ? m.rows.map((r) => ({ key: r.key, opId: r.opId, state: 'done' as const }))
          : [],
    },
  })
  return {
    current: async () => [ticket('ENG-1'), ticket('ENG-2')],
    viewerId: () => ME,
    prepare: vi.fn(async (m: TicketMutation) => ({
      approvalId: 'appr-1',
      keys: m.kind === 'applyPlan' ? m.rows.map((r) => r.key) : [],
    })),
    commit: vi.fn(async ({ mutation }: { mutation: TicketMutation }) => ({
      outcome: outcome(mutation),
    })),
    ...over,
  } as never
}

describe('plan runtime (plan-actor)', () => {
  it('writes mixed and start-only rows as one applyPlan through prepare then commit', async () => {
    const d = deps()
    const rows = [
      row('ENG-1', 1, { plannedStart: '2026-12-01' }),
      row('ENG-2', 2, { dueDate: undefined, plannedStart: '2026-12-02' }),
    ]
    const out = await applyRows({ rows, opId: uuid(50) }, d)
    expect(out).toEqual({
      kind: 'done',
      results: [
        { key: 'ENG-1', state: 'done' },
        { key: 'ENG-2', state: 'done' },
      ],
    })
    const mutation = {
      kind: 'applyPlan',
      rows: [
        {
          key: 'ENG-1',
          issueId: 'issue-ENG-1',
          opId: uuid(1),
          baseUpdatedAt: T0,
          basePlannedStart: null,
          dueDate: '2026-12-09',
          plannedStart: '2026-12-01',
        },
        {
          key: 'ENG-2',
          issueId: 'issue-ENG-2',
          opId: uuid(2),
          baseUpdatedAt: T0,
          basePlannedStart: null,
          plannedStart: '2026-12-02',
        },
      ],
    }
    expect(d.prepare).toHaveBeenCalledWith(mutation)
    expect(d.commit).toHaveBeenCalledWith({ approvalId: 'appr-1', opId: uuid(50), mutation })
  })

  it('commits nothing when the host would write other tickets than the draft', async () => {
    const d = deps({ prepare: vi.fn(async () => ({ approvalId: 'appr-1', keys: ['ENG-7'] })) })
    expect(await applyRows({ rows: [row('ENG-1', 1)], opId: uuid(50) }, d)).toEqual({
      kind: 'refused',
      message: OTHER_ROWS,
    })
    expect(d.commit).not.toHaveBeenCalled()
  })

  it('writes nothing when a ticket, its Relay start or its issue changed since the draft', async () => {
    for (const now of [
      ticket('ENG-1', { updatedAt: T0 + 1 }),
      ticket('ENG-1', { plannedStart: '2026-11-30' }),
      ticket('ENG-1', { id: 'issue-other' }),
    ]) {
      const d = deps({ current: async () => [now] })
      expect(await applyRows({ rows: [row('ENG-1', 1)], opId: uuid(50) }, d)).toEqual({
        kind: 'stale',
        keys: ['ENG-1'],
      })
      expect(d.prepare).not.toHaveBeenCalled()
    }
  })

  it('a conflict refusal is stale; another refusal carries its reason', async () => {
    const conflict = deps({
      prepare: vi.fn(async () => ({ refused: { code: 'conflict', message: 'changed' } })),
    })
    expect(await applyRows({ rows: [row('ENG-1', 1)], opId: uuid(50) }, conflict)).toEqual({
      kind: 'stale',
      keys: ['ENG-1'],
    })
    const off = deps({
      commit: vi.fn(async () => ({ refused: { code: 'writesOff', message: 'Writes are off' } })),
    })
    expect(await applyRows({ rows: [row('ENG-1', 1)], opId: uuid(50) }, off)).toEqual({
      kind: 'refused',
      message: 'Writes are off',
    })
  })

  it('reports each row’s own outcome by its opId, from a failed batch too', async () => {
    const outcome: TicketOutcome = {
      opId: uuid(50),
      state: 'unknown',
      result: {
        rows: [
          { key: 'ENG-1', opId: uuid(1), state: 'failed', error: 'Nope' },
          { key: 'ENG-2', opId: uuid(2), state: 'unknown' },
          {
            key: 'ENG-3',
            opId: uuid(3),
            state: 'failed',
            error: 'Written to Linear, but no start',
          },
        ],
      },
    }
    const d = deps({
      current: async () => [ticket('ENG-1'), ticket('ENG-2'), ticket('ENG-3')],
      commit: vi.fn(async () => ({ outcome })),
    })
    const rows = [row('ENG-1', 1), row('ENG-2', 2), row('ENG-3', 3, { plannedStart: '2026-12-01' })]
    const out = await applyRows({ rows, opId: uuid(50) }, d)
    expect(out).toMatchObject({
      kind: 'done',
      results: [
        { key: 'ENG-1', state: 'failed', error: 'Nope' },
        { key: 'ENG-2', state: 'unknown' },
        { key: 'ENG-3', state: 'failed', error: 'Written to Linear, but no start' },
      ],
    })
  })

  it('Check sends the same commit without an approval; a batch the host never got is unsent', async () => {
    const d = deps()
    const input = { rows: [row('ENG-1', 1)], opId: uuid(50) }
    expect(await checkRows(input, d)).toEqual({
      kind: 'done',
      results: [{ key: 'ENG-1', state: 'done' }],
    })
    expect(d.prepare).not.toHaveBeenCalled()
    expect(d.commit.mock.calls[0]![0]).toEqual({
      opId: uuid(50),
      mutation: { kind: 'applyPlan', rows: [expect.objectContaining({ opId: uuid(1) })] },
    })
    const never = deps({
      commit: vi.fn(async () => ({ refused: { code: 'approval', message: 'Confirm it first' } })),
    })
    expect(await checkRows(input, never)).toEqual({ kind: 'unsent' })
    const other = deps({
      commit: vi.fn(async () => ({ refused: { code: 'identity', message: 'Another account' } })),
    })
    expect(await checkRows(input, other)).toEqual({ kind: 'refused', message: 'Another account' })
  })

  it('reads Astra’s answer against the host’s baseline; another account or no baseline is refused', async () => {
    let n = 100
    const mint = (): string => uuid(++n)
    const baseline = [
      { key: 'ENG-1', issueId: 'issue-ENG-1', updatedAt: T0, ...BASE },
      { key: 'ENG-2', issueId: 'issue-ENG-2', updatedAt: T0 - 5, ...BASE },
    ]
    const answer = {
      summary: 'Pull ENG-1 in',
      changes: [
        { key: 'ENG-1', dueDate: '2026-12-03', reason: 'Blocks ENG-2' },
        { key: 'ENG-2', dueDate: '2026-12-04', reason: 'Changed since' },
        { key: 'ENG-9', dueDate: '2026-12-03', reason: 'Not on this milestone' },
      ],
      viewerId: ME,
      baseline,
    }
    const out = await replanRows(SCOPE, deps({ replan: async () => answer }), mint)
    expect(out?.summary).toBe('Pull ENG-1 in')
    expect(out?.rows).toEqual([
      {
        key: 'ENG-1',
        issueId: 'issue-ENG-1',
        opId: uuid(101),
        baseUpdatedAt: T0,
        base: BASE,
        dueDate: '2026-12-03',
        reason: 'Blocks ENG-2',
      },
      expect.objectContaining({ key: 'ENG-2', baseUpdatedAt: T0 - 5, stale: true }),
    ])
    const other = deps({ replan: async () => ({ ...answer, viewerId: 'user-old' }) })
    await expect(replanRows(SCOPE, other)).rejects.toThrow(OTHER_ACCOUNT)
    const bare = deps({ replan: async () => ({ summary: 's', changes: answer.changes }) })
    expect(await replanRows(SCOPE, bare)).toBeNull()
    expect(await replanRows(SCOPE, deps({ replan: async () => ({ plan: 'later' }) }))).toBeNull()
    await expect(replanRows(SCOPE, deps())).rejects.toThrow(NEEDS_NEWER_HOST)
  })
})
