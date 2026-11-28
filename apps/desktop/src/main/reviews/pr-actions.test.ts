import { describe, expect, it } from 'vitest'
import { REVIEWS_ACTIONS_FEATURE } from '@relay/protocol'
import type { RelayFeatures, RelayFrames } from '../relay/client'
import { createHostReviews } from '../relay/host-reviews'
import { PR_ACTIONS_UNAVAILABLE, prActions } from './remote-reviews'

type Frame = Record<string, unknown>
const H1 = 'a'.repeat(40)
const OP = '6d796135-613d-4bd8-ae3f-d928a50f7531'
const MERGE = {
  kind: 'merge',
  repo: 'eCardSystems/api',
  number: 42,
  method: 'squash',
  expectHead: H1,
  expectBase: 'main',
}
const ME = 'webdevike'

/** A Relay Host answering `reviews.req` with `answer(op)`. */
class FakeHost implements RelayFrames, RelayFeatures {
  features: string[] = [REVIEWS_ACTIONS_FEATURE]
  sent: Frame[] = []
  answer: (op: Frame) => Frame = () => ({ ok: true })
  private listeners = new Set<(f: Frame) => void>()

  onFrame(cb: (f: Frame) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  hostHas(feature: string): boolean {
    return this.features.includes(feature)
  }
  sendFrame(frame: Frame): boolean {
    this.sent.push(frame)
    const res = { t: 'reviews.res', rid: frame.rid, ...this.answer(frame.op as Frame) }
    queueMicrotask(() => {
      for (const cb of [...this.listeners]) cb(res)
    })
    return true
  }
}

function setup() {
  const host = new FakeHost()
  return { host, actions: prActions(host, createHostReviews(host)) }
}

describe('PR actions', () => {
  it('sends nothing to a host without reviews.actions and answers why', async () => {
    const { host, actions } = setup()
    host.features = []
    expect(await actions.prepare({ login: ME, mutation: MERGE })).toEqual({
      unavailable: PR_ACTIONS_UNAVAILABLE,
    })
    expect(await actions.commit({ login: ME, opId: OP, mutation: MERGE })).toEqual({
      unavailable: PR_ACTIONS_UNAVAILABLE,
    })
    expect(host.sent).toEqual([])
  })

  it('forwards prPrepare and prCommit and answers the gate approval and outcome', async () => {
    const { host, actions } = setup()
    host.answer = (op) =>
      op.kind === 'prPrepare'
        ? { ok: true, approval: { id: 'a-1', expiresAt: 5, summary: 'Merge now' } }
        : { ok: true, outcome: { opId: OP, state: 'done', result: { merge: 'merged' } } }
    expect(await actions.prepare({ login: ME, mutation: MERGE })).toEqual({
      source: 'host',
      ok: true,
      approval: { id: 'a-1', expiresAt: 5, summary: 'Merge now' },
    })
    expect(
      await actions.commit({ login: ME, approvalId: 'a-1', opId: OP, mutation: MERGE }),
    ).toEqual({
      source: 'host',
      ok: true,
      outcome: { opId: OP, state: 'done', result: { merge: 'merged' } },
    })
    expect(host.sent.map((f) => f.op)).toEqual([
      { kind: 'prPrepare', login: ME, mutation: MERGE },
      { kind: 'prCommit', login: ME, opId: OP, mutation: MERGE, approvalId: 'a-1' },
    ])
  })

  it('answers the gate refusal and a failed write as answers, not errors', async () => {
    const { host, actions } = setup()
    host.answer = () => ({
      ok: false,
      refused: { code: 'conflict', message: 'New commits since you looked' },
    })
    expect(await actions.prepare({ login: ME, mutation: MERGE })).toEqual({
      source: 'host',
      ok: false,
      refused: { code: 'conflict', message: 'New commits since you looked' },
    })
    host.answer = () => ({
      ok: false,
      error: 'gh pr merge failed',
      outcome: { opId: OP, state: 'failed' },
    })
    expect(await actions.commit({ login: ME, opId: OP, mutation: MERGE })).toEqual({
      source: 'host',
      ok: false,
      error: 'gh pr merge failed',
      outcome: { opId: OP, state: 'failed' },
    })
  })

  it('rejects a mutation the protocol refuses before anything goes out', async () => {
    const { host, actions } = setup()
    await expect(
      actions.prepare({ login: ME, mutation: { ...MERGE, method: 'admin' } }),
    ).rejects.toThrow()
    await expect(
      actions.prepare({ login: ME, mutation: { ...MERGE, expectHead: 'abc' } }),
    ).rejects.toThrow()
    expect(host.sent).toEqual([])
  })
})
