import { describe, expect, it, vi } from 'vitest'
import { createActor, fromPromise, SimulatedClock, waitFor } from 'xstate'
import type { AgentCard } from '@evaos/contract'
import {
  cardMoveMachine,
  CHANGED,
  type CommitInput,
  type CommitResult,
  type MoveResolution,
  type PrepareResult,
} from './card-move.machine'

const card = (over: Partial<AgentCard> = {}): AgentCard => ({
  id: 'ticket:ENG-1',
  kind: 'ticket',
  key: 'ENG-1',
  title: 'T',
  column: 'queued',
  pill: { label: 'Todo', tone: 'default' },
  reason: 'Todo in Linear',
  workspace: null,
  agent: null,
  session: null,
  intent: null,
  stage: null,
  move: null,
  next: null,
  phase: null,
  pr: null,
  linear: null,
  activityAt: 1,
  stale: false,
  links: [],
  ticket: {
    id: 'issue-1',
    state: { id: 'todo', name: 'Todo', type: 'unstarted', color: '#fff' },
    team: { id: 'team-eng', key: 'ENG' },
    priority: 0,
    project: null,
    milestone: null,
    labels: [],
    parent: null,
    sub: null,
    assignee: null,
    createdAt: 1,
    updatedAt: 1,
    prs: [],
    waiting: null,
    needsYou: null,
  },
  openTarget: { kind: 'ticket', key: 'ENG-1' },
  dragBlock: null,
  ...over,
})

const PROGRESS = { id: 'progress', name: 'In Progress', type: 'started' }
const DONE = { id: 'done', name: 'Done', type: 'completed' }

interface Stubs {
  resolve?: MoveResolution
  prepare?: PrepareResult
  /** One result per commit call; a thrown Error is a lost response. */
  commits?: Array<CommitResult | Error>
  reconcile?: string
}

function start(stubs: Stubs, clock?: SimulatedClock) {
  const calls = { resolve: 0, prepare: 0, commit: [] as CommitInput[], reconcile: 0 }
  const commits = [...(stubs.commits ?? [{ kind: 'done' }])]
  const machine = cardMoveMachine.provide({
    actors: {
      resolve: fromPromise(async () => {
        calls.resolve += 1
        return stubs.resolve ?? { kind: 'state', state: PROGRESS }
      }),
      prepare: fromPromise(async () => {
        calls.prepare += 1
        return stubs.prepare ?? { kind: 'approved', approvalId: 'appr-1' }
      }),
      commit: fromPromise(async ({ input }) => {
        calls.commit.push(input)
        const next = commits.shift() ?? { kind: 'done' }
        if (next instanceof Error) throw next
        return next
      }),
      reconcile: fromPromise(async () => {
        calls.reconcile += 1
        return { stateId: stubs.reconcile ?? 'todo' }
      }),
    },
  })
  const actor = createActor(machine, clock ? { clock } : {}).start()
  return { actor, calls }
}

const drop = (to: AgentCard['column'] = 'working', over: Partial<AgentCard> = {}) =>
  ({ type: 'move.drop', card: card(over), to, opId: 'op-1' }) as const

describe('cardMoveMachine', () => {
  it('writes a non-terminal move at once with the drop’s opId, then offers Undo', async () => {
    const { actor, calls } = start({})
    actor.send(drop())
    const s = await waitFor(actor, (x) => x.matches({ ready: 'settled' }))
    expect(calls.prepare).toBe(0)
    expect(calls.commit).toEqual([
      {
        opId: 'op-1',
        approvalId: null,
        mutation: {
          kind: 'setState',
          issueId: 'issue-1',
          fromStateId: 'todo',
          toStateId: 'progress',
        },
      },
    ])
    expect(s.context.write?.column).toBe('working')
    expect(s.can({ type: 'move.undo', currentStateId: null, opId: 'op-2' })).toBe(true)
  })

  it('refuses an agent-driven card without resolving or writing', () => {
    const { actor, calls } = start({})
    actor.send(drop('done', { dragBlock: 'Astra is working on this; the column follows her run' }))
    const s = actor.getSnapshot()
    expect(s.matches({ ready: 'staysPut' })).toBe(true)
    expect(s.context.message).toContain('Astra is working on this')
    expect(calls.resolve + calls.commit.length).toBe(0)
  })

  it('ignores a drop on the card’s own column', () => {
    const { actor, calls } = start({})
    actor.send(drop('queued'))
    expect(actor.getSnapshot().matches({ ready: 'idle' })).toBe(true)
    expect(calls.resolve).toBe(0)
  })

  it('shows a stays-put refusal from the resolver and writes nothing', async () => {
    const { actor, calls } = start({
      resolve: { kind: 'stays', message: 'This card stays in In review: PR #9 is open' },
    })
    actor.send(drop())
    const s = await waitFor(actor, (x) => x.matches({ ready: 'staysPut' }))
    expect(s.context.message).toBe('This card stays in In review: PR #9 is open')
    expect(calls.commit).toHaveLength(0)
  })

  it('confirms Done, gets the gate’s approval, then commits with it', async () => {
    const { actor, calls } = start({ resolve: { kind: 'state', state: DONE } })
    actor.send(drop('done'))
    await waitFor(actor, (x) => x.matches('confirming'))
    expect(calls.prepare + calls.commit.length).toBe(0)
    actor.send({ type: 'move.confirm' })
    await waitFor(actor, (x) => x.matches({ ready: 'settled' }))
    expect(calls.prepare).toBe(1)
    expect(calls.commit[0]).toMatchObject({ opId: 'op-1', approvalId: 'appr-1' })
  })

  it('cancels from confirming without a write', async () => {
    const { actor, calls } = start({ resolve: { kind: 'state', state: DONE } })
    actor.send(drop('done'))
    await waitFor(actor, (x) => x.matches('confirming'))
    actor.send({ type: 'move.cancel' })
    const s = actor.getSnapshot()
    expect(s.matches({ ready: 'idle' })).toBe(true)
    expect(s.context.card).toBeNull()
    expect(calls.prepare + calls.commit.length).toBe(0)
  })

  it('asks which state when several match, and writes the one picked', async () => {
    const other = { id: 'building', name: 'Building', type: 'started' }
    const { actor, calls } = start({ resolve: { kind: 'ambiguous', options: [PROGRESS, other] } })
    actor.send(drop())
    await waitFor(actor, (x) => x.matches('pickState'))
    actor.send({ type: 'move.pick', stateId: 'nope' })
    expect(actor.getSnapshot().matches('pickState')).toBe(true)
    actor.send({ type: 'move.pick', stateId: 'building' })
    await waitFor(actor, (x) => x.matches({ ready: 'settled' }))
    expect(calls.commit[0]?.mutation.toStateId).toBe('building')
  })

  it('rolls back on a conflict refusal', async () => {
    const { actor } = start({
      commits: [{ kind: 'refused', code: 'conflict', message: CHANGED }],
    })
    actor.send(drop())
    const s = await waitFor(actor, (x) => x.matches({ ready: 'conflict' }))
    expect(s.context.message).toBe(CHANGED)
    expect(s.can({ type: 'move.retry' })).toBe(false)
  })

  it('reconciles a lost response by reading the ticket, never writing again on its own', async () => {
    const { actor, calls } = start({ commits: [new Error('timed out')], reconcile: 'progress' })
    actor.send(drop())
    await waitFor(actor, (x) => x.matches({ ready: 'settled' }))
    expect(calls.reconcile).toBe(1)
    expect(calls.commit).toHaveLength(1)
  })

  it('retries a move that didn’t land with the same opId (the host dedupes it)', async () => {
    const { actor, calls } = start({ commits: [new Error('timed out'), { kind: 'done' }] })
    actor.send(drop())
    const failed = await waitFor(actor, (x) => x.matches({ ready: 'failed' }))
    expect(failed.context.message).toBe('It didn’t move. Try again.')
    expect(calls.commit).toHaveLength(1)
    actor.send({ type: 'move.retry' })
    await waitFor(actor, (x) => x.matches({ ready: 'settled' }))
    expect(calls.commit.map((c) => c.opId)).toEqual(['op-1', 'op-1'])
  })

  it('retries a failed Done through the gate again when it has no approval', async () => {
    const { actor, calls } = start({
      resolve: { kind: 'state', state: DONE },
      prepare: { kind: 'refused', code: 'identity', message: 'Sync as someone else' },
    })
    actor.send(drop('done'))
    await waitFor(actor, (x) => x.matches('confirming'))
    actor.send({ type: 'move.confirm' })
    const s = await waitFor(actor, (x) => x.matches({ ready: 'failed' }))
    expect(s.context.message).toBe('Sync as someone else')
    actor.send({ type: 'move.retry' })
    await waitFor(actor, (x) => x.matches({ ready: 'failed' }))
    expect(calls.prepare).toBe(2)
    expect(calls.commit).toHaveLength(0)
  })

  it('undoes with the swapped move and a new opId', async () => {
    const { actor, calls } = start({ commits: [{ kind: 'done' }, { kind: 'done' }] })
    actor.send(drop())
    await waitFor(actor, (x) => x.matches({ ready: 'settled' }))
    actor.send({ type: 'move.undo', currentStateId: 'progress', opId: 'op-2' })
    const s = await waitFor(actor, (x) => x.matches({ ready: 'settled' }) && x.context.undo)
    expect(calls.commit[1]).toEqual({
      opId: 'op-2',
      approvalId: null,
      mutation: {
        kind: 'setState',
        issueId: 'issue-1',
        fromStateId: 'progress',
        toStateId: 'todo',
      },
    })
    expect(s.context.write?.column).toBe('queued')
    expect(s.can({ type: 'move.undo', currentStateId: null, opId: 'op-3' })).toBe(false)
  })

  it('refuses Undo once the card moved on in Linear', async () => {
    const { actor, calls } = start({})
    actor.send(drop())
    await waitFor(actor, (x) => x.matches({ ready: 'settled' }))
    actor.send({ type: 'move.undo', currentStateId: 'review', opId: 'op-2' })
    const s = actor.getSnapshot()
    expect(s.matches({ ready: 'conflict' })).toBe(true)
    expect(s.context.message).toBe('Changed in Linear since you moved it; nothing was undone')
    expect(calls.commit).toHaveLength(1)
  })

  it('closes the Undo window after 8 s', async () => {
    const clock = new SimulatedClock()
    const { actor } = start({}, clock)
    actor.send(drop())
    await waitFor(actor, (x) => x.matches({ ready: 'settled' }))
    clock.increment(7_999)
    expect(actor.getSnapshot().matches({ ready: 'settled' })).toBe(true)
    clock.increment(1)
    expect(actor.getSnapshot().matches({ ready: 'idle' })).toBe(true)
  })

  it('takes no new drop while a write is in flight', async () => {
    let land: (r: CommitResult) => void = () => undefined
    const commit = vi.fn(() => new Promise<CommitResult>((r) => (land = r)))
    const machine = cardMoveMachine.provide({
      actors: {
        resolve: fromPromise(async (): Promise<MoveResolution> => ({
          kind: 'state',
          state: PROGRESS,
        })),
        commit: fromPromise(commit),
      },
    })
    const actor = createActor(machine).start()
    actor.send(drop())
    await waitFor(actor, (x) => x.matches('writing'))
    expect(actor.getSnapshot().can(drop('review', { id: 'ticket:ENG-2' }))).toBe(false)
    land({ kind: 'done' })
    await waitFor(actor, (x) => x.matches({ ready: 'settled' }))
    expect(commit).toHaveBeenCalledTimes(1)
  })
})
