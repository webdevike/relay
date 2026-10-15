import { describe, expect, it } from 'vitest'
import { SeqBatcher } from './batcher'
import { makeMessage } from './message'

const m = (id: string, t: string) => makeMessage(id, 'assistant', t)

describe('SeqBatcher', () => {
  it('coalesces upserts of one id and stamps seq 1, 2, 3', () => {
    const b = new SeqBatcher('pane-1')
    b.markUpsert(m('a', 'x'))
    b.markUpsert(m('a', 'xy'))
    b.markUpsert(m('a', 'xyz'))
    const one = b.flush()!
    expect(one.seq).toBe(1)
    expect(one.paneId).toBe('pane-1')
    expect(one.ops).toEqual([{ op: 'upsert', message: m('a', 'xyz') }])
    b.markUpsert(m('a', 'more'))
    expect(b.flush()!.seq).toBe(2)
    b.markMeta({ running: false })
    const three = b.flush()!
    expect(three.seq).toBe(3)
    expect(three.ops).toEqual([{ op: 'meta', patch: { running: false } }])
  })

  it('an empty flush emits nothing and does not advance seq', () => {
    const b = new SeqBatcher('p')
    expect(b.flush()).toBeNull()
    b.markUpsert(m('a', 'x'))
    b.flush()
    expect(b.flush()).toBeNull()
    expect(b.currentSeq).toBe(1)
  })

  it('removes come first and upserts follow in list order', () => {
    const b = new SeqBatcher('p')
    b.markUpsert(m('late', 'l'), 5)
    b.markUpsert(m('early', 'e'), 2)
    b.markRemove('gone')
    const ids = b
      .flush()!
      .ops.map((o) => (o.op === 'remove' ? o.id : o.op === 'upsert' ? o.message.id : 'meta'))
    expect(ids).toEqual(['gone', 'early', 'late'])
  })

  it('removing a pending upsert cancels it', () => {
    const b = new SeqBatcher('p')
    b.markUpsert(m('a', 'x'))
    b.markRemove('a')
    expect(b.flush()!.ops).toEqual([{ op: 'remove', id: 'a' }])
  })

  it('snapshot returns the current seq and the full messages', () => {
    const b = new SeqBatcher('p')
    b.markUpsert(m('a', 'x'))
    b.flush()
    const snap = b.snapshot(
      [m('a', 'x')],
      { model: null, thinking: null, contextTokens: null },
      { running: true, connected: true, error: null },
    )
    expect(snap.seq).toBe(1)
    expect(snap.messages).toHaveLength(1)
    expect(snap.running).toBe(true)
    expect(snap.connected).toBe(true)
    expect(snap.error).toBeNull()
  })

  it('snapshot carries the stopped state and the error a lost meta batch would have had', () => {
    const b = new SeqBatcher('p')
    const snap = b.snapshot(
      [],
      { model: null, thinking: null, contextTokens: null },
      { running: false, connected: false, error: 'ended' },
    )
    expect(snap).toMatchObject({ seq: 0, running: false, connected: false, error: 'ended' })
  })

  it('meta patches for dialog, sessionFile and contextWindow merge; the last dialog wins', () => {
    const b = new SeqBatcher('p')
    const d = { kind: 'confirm', id: 'x', title: 't', message: 'm' } as const
    b.markMeta({ dialog: d })
    b.markMeta({ dialog: null, sessionFile: '/s/a.jsonl' })
    b.markMeta({ contextWindow: 200000 })
    const batch = b.flush()
    expect(batch?.ops).toEqual([
      { op: 'meta', patch: { dialog: null, sessionFile: '/s/a.jsonl', contextWindow: 200000 } },
    ])
  })
})
