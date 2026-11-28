import { describe, expect, it, vi } from 'vitest'
import { createActor, fromPromise, waitFor } from 'xstate'
import {
  CHANGED,
  CHECKING,
  prMergeMachine,
  type CommitInput,
  type CommitResult,
  type MergeMutation,
  type MergePr,
  type PrepareResult,
} from './pr-merge.machine'

const HEAD = 'a'.repeat(40)
const NEW_HEAD = 'b'.repeat(40)
const PR: MergePr = { repo: 'o/r', number: 42, base: 'main', headSha: HEAD }
const NOW = { method: 'squash', intent: 'merge', outcome: 'Merge now' } as const
const AUTO = { method: 'squash', intent: 'auto', outcome: 'Turn on auto-merge' } as const

function start(
  prepare: (m: MergeMutation) => Promise<PrepareResult>,
  commit: (i: CommitInput) => Promise<CommitResult>,
) {
  const prepares = vi.fn(prepare)
  const commits = vi.fn(commit)
  const actor = createActor(
    prMergeMachine.provide({
      actors: {
        prepare: fromPromise(({ input }: { input: { mutation: MergeMutation } }) =>
          prepares(input.mutation),
        ),
        commit: fromPromise(({ input }: { input: CommitInput }) => commits(input)),
      },
    }),
  )
  actor.start()
  return { actor, prepares, commits }
}

const approve = (): Promise<PrepareResult> =>
  Promise.resolve({ kind: 'approved', approvalId: 'ap-1' })
const value = (a: { getSnapshot(): { value: unknown } }) => a.getSnapshot().value

describe('prMergeMachine', () => {
  it('confirm prepares then commits once, bound to the confirmed head', async () => {
    const { actor, prepares, commits } = start(approve, () => Promise.resolve({ kind: 'merged' }))
    actor.send({ type: 'merge.start', pr: PR, plan: NOW })
    expect(value(actor)).toBe('confirming')
    expect(prepares).not.toHaveBeenCalled()
    actor.send({ type: 'merge.confirm', opId: 'op-1' })
    await waitFor(actor, (s) => s.matches('merged'))
    const mutation = {
      kind: 'merge',
      repo: 'o/r',
      number: 42,
      method: 'squash',
      intent: 'merge',
      expectHead: HEAD,
    }
    expect(prepares).toHaveBeenCalledExactlyOnceWith(mutation)
    expect(commits).toHaveBeenCalledExactlyOnceWith({ opId: 'op-1', approvalId: 'ap-1', mutation })
  })

  it('cancel writes nothing', () => {
    const { actor, prepares, commits } = start(approve, () => Promise.resolve({ kind: 'merged' }))
    actor.send({ type: 'merge.start', pr: PR, plan: NOW })
    actor.send({ type: 'merge.cancel' })
    expect(value(actor)).toBe('idle')
    expect(prepares).not.toHaveBeenCalled()
    expect(commits).not.toHaveBeenCalled()
  })

  it('a new head during the confirm goes stale; reconfirm binds the new head', async () => {
    const { actor, commits } = start(approve, () => Promise.resolve({ kind: 'merged' }))
    actor.send({ type: 'merge.start', pr: PR, plan: NOW })
    actor.send({ type: 'merge.facts', pr: PR, outcome: 'Merge now', armed: null })
    expect(value(actor)).toBe('confirming')
    actor.send({
      type: 'merge.facts',
      pr: { ...PR, headSha: NEW_HEAD },
      outcome: 'Merge now',
      armed: null,
    })
    expect(value(actor)).toBe('stale')
    expect(actor.getSnapshot().context.message).toBe(CHANGED)
    expect(actor.getSnapshot().can({ type: 'merge.confirm', opId: 'op-1' })).toBe(false)
    actor.send({ type: 'merge.reconfirm', plan: NOW })
    expect(value(actor)).toBe('confirming')
    actor.send({ type: 'merge.confirm', opId: 'op-2' })
    await waitFor(actor, (s) => s.matches('merged'))
    expect(commits.mock.calls[0]![0].mutation.expectHead).toBe(NEW_HEAD)
    expect(commits.mock.calls[0]![0].opId).toBe('op-2')
  })

  it('a changed outcome while the gate approves goes stale and never commits', async () => {
    // (Promise.withResolvers is past this app's TS lib target.)
    let approveNow!: (r: PrepareResult) => void
    const gate = {
      promise: new Promise<PrepareResult>((r) => (approveNow = r)),
      resolve: (r: PrepareResult) => approveNow(r),
    }
    const { actor, commits } = start(
      () => gate.promise,
      () => Promise.resolve({ kind: 'merged' }),
    )
    actor.send({ type: 'merge.start', pr: PR, plan: NOW })
    actor.send({ type: 'merge.confirm', opId: 'op-1' })
    expect(value(actor)).toBe('preparing')
    actor.send({ type: 'merge.facts', pr: PR, outcome: 'Turn on auto-merge', armed: null })
    expect(value(actor)).toBe('stale')
    gate.resolve({ kind: 'approved', approvalId: 'ap-1' })
    await Promise.resolve()
    expect(value(actor)).toBe('stale')
    expect(commits).not.toHaveBeenCalled()
  })

  it('the host’s conflict refusal (head moved) is stale too', async () => {
    const { actor } = start(approve, () =>
      Promise.resolve({ kind: 'refused', code: 'conflict', message: 'Head moved' }),
    )
    actor.send({ type: 'merge.start', pr: PR, plan: NOW })
    actor.send({ type: 'merge.confirm', opId: 'op-1' })
    await waitFor(actor, (s) => s.matches('stale'))
    expect(actor.getSnapshot().context.approvalId).toBeNull()
  })

  it('a refusal shows the reason and writes nothing', async () => {
    const { actor, commits } = start(
      () => Promise.resolve({ kind: 'refused', code: 'writesOff', message: 'Writes are off' }),
      () => Promise.resolve({ kind: 'merged' }),
    )
    actor.send({ type: 'merge.start', pr: PR, plan: NOW })
    actor.send({ type: 'merge.confirm', opId: 'op-1' })
    await waitFor(actor, (s) => s.matches('refused'))
    expect(actor.getSnapshot().context.message).toBe('Writes are off')
    expect(commits).not.toHaveBeenCalled()
    actor.send({ type: 'merge.dismiss' })
    expect(value(actor)).toBe('idle')
  })

  it('a lost answer fails; retry asks again with the same opId and approval', async () => {
    let tries = 0
    const { actor, prepares, commits } = start(approve, () =>
      ++tries === 1 ? Promise.reject(new Error('timed out')) : Promise.resolve({ kind: 'merged' }),
    )
    actor.send({ type: 'merge.start', pr: PR, plan: NOW })
    actor.send({ type: 'merge.confirm', opId: 'op-1' })
    await waitFor(actor, (s) => s.matches('failed'))
    expect(actor.getSnapshot().context.message).toBe(CHECKING)
    actor.send({ type: 'merge.retry' })
    await waitFor(actor, (s) => s.matches('merged'))
    expect(prepares).toHaveBeenCalledTimes(1)
    expect(commits.mock.calls.map((c) => [c[0].opId, c[0].approvalId])).toEqual([
      ['op-1', 'ap-1'],
      ['op-1', 'ap-1'],
    ])
  })

  it('a failed approval retries from the gate with the same opId', async () => {
    let tries = 0
    const { actor, commits } = start(
      () =>
        ++tries === 1
          ? Promise.resolve({ kind: 'failed', message: 'No host' })
          : Promise.resolve({ kind: 'approved', approvalId: 'ap-2' }),
      () => Promise.resolve({ kind: 'merged' }),
    )
    actor.send({ type: 'merge.start', pr: PR, plan: NOW })
    actor.send({ type: 'merge.confirm', opId: 'op-1' })
    await waitFor(actor, (s) => s.matches('failed'))
    actor.send({ type: 'merge.retry' })
    await waitFor(actor, (s) => s.matches('merged'))
    expect(commits).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ opId: 'op-1', approvalId: 'ap-2' }),
    )
  })

  it.each([
    ['merged', 'merged'],
    ['queued', 'queued'],
    ['autoMergeArmed', 'autoMergeArmed'],
  ] as const)('the host’s read-back %s lands in %s', async (kind, state) => {
    const { actor } = start(approve, () => Promise.resolve({ kind }))
    actor.send({ type: 'merge.start', pr: PR, plan: kind === 'merged' ? NOW : AUTO })
    actor.send({ type: 'merge.confirm', opId: 'op-1' })
    await waitFor(actor, (s) => s.matches(state))
  })

  it('disarms an armed auto-merge with one unconfirmed write', async () => {
    const { actor, prepares, commits } = start(approve, () => Promise.resolve({ kind: 'done' }))
    actor.send({
      type: 'merge.facts',
      pr: PR,
      outcome: null,
      armed: { method: 'squash', by: 'me' },
    })
    expect(value(actor)).toBe('autoMergeArmed')
    actor.send({ type: 'merge.disarm', opId: 'op-9' })
    await waitFor(actor, (s) => s.matches('idle'))
    expect(prepares).not.toHaveBeenCalled()
    expect(commits).toHaveBeenCalledExactlyOnceWith({
      opId: 'op-9',
      approvalId: null,
      mutation: { kind: 'autoMerge', repo: 'o/r', number: 42, on: false, expectHead: HEAD },
    })
  })

  it('a refused disarm stays armed with the reason', async () => {
    const { actor } = start(approve, () =>
      Promise.resolve({ kind: 'refused', code: 'writesOff', message: 'Writes are off' }),
    )
    actor.send({ type: 'merge.facts', pr: PR, outcome: null, armed: { method: 'merge', by: null } })
    actor.send({ type: 'merge.disarm', opId: 'op-9' })
    await waitFor(actor, (s) => s.matches('autoMergeArmed') && s.context.message !== null)
    expect(actor.getSnapshot().context.message).toBe('Writes are off')
    // A read without auto-merge (turned off on GitHub, or by the host on a new head) goes idle.
    actor.send({ type: 'merge.facts', pr: PR, outcome: 'Merge now', armed: null })
    expect(value(actor)).toBe('idle')
  })
})
