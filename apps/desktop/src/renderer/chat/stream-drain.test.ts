import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeMessage, type ChatMessage } from '@evaos/chat-core/message'
import type { Batch } from '@evaos/contract'
import { chatStore } from './chat-store'
import { createStreamDrain, type Snapshot } from './stream-drain'

const meta = { model: null, thinking: null, contextTokens: null }
const a = (id: string, text: string): ChatMessage => makeMessage(id, 'assistant', text)
const batch = (seq: number, ...messages: ChatMessage[]): Batch => ({
  paneId: 'pane-1',
  seq,
  ops: messages.map((message) => ({ op: 'upsert' as const, message })),
})

function setup(opts: { snapshot?: Snapshot } = {}) {
  chatStore.setState({ panes: {} })
  chatStore.getState().openPane('pane-1', { file: '/f', title: 't', messages: [], meta })
  let tick: (() => void) | null = null
  const raf = vi.fn((cb: () => void) => {
    tick = cb
  })
  const requestSnapshot = vi.fn(() => Promise.resolve(opts.snapshot ?? null))
  const drain = createStreamDrain({ store: chatStore, raf, requestSnapshot, minReconnectMs: 0 })
  return { drain, raf, requestSnapshot, flush: () => tick?.() }
}
const pane = () => chatStore.getState().panes['pane-1']!

describe('stream drain', () => {
  beforeEach(() => chatStore.setState({ panes: {} }))

  it('applies batches 1..3 delivered before one tick in a single store update', () => {
    const { drain, raf, flush } = setup()
    let updates = 0
    const unsub = chatStore.subscribe(() => updates++)
    drain.push(batch(1, a('x', 'a')))
    drain.push(batch(2, a('x', 'ab')))
    drain.push(batch(3, a('x', 'abc')))
    expect(raf).toHaveBeenCalledTimes(1)
    flush()
    unsub()
    expect(updates).toBe(1)
    expect(pane().lastSeq).toBe(3)
    expect(pane().messages.map((m) => m.text)).toEqual(['abc'])
  })

  it('recovers from a seq gap with one snapshot, ignores late batches, applies the next', async () => {
    const snapshot: Snapshot = { seq: 6, messages: [a('x', 'snap')], meta, running: true }
    const { drain, requestSnapshot, flush } = setup({ snapshot })
    drain.push(batch(1, a('x', 'a')))
    flush()
    drain.push(batch(2, a('x', 'ab')))
    drain.push(batch(5, a('x', 'gap')))
    expect(pane().reconnecting).toBe(true)
    expect(requestSnapshot).toHaveBeenCalledTimes(1)
    flush()
    expect(pane().lastSeq).toBe(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(pane().messages.map((m) => m.text)).toEqual(['snap'])
    expect(pane().lastSeq).toBe(6)
    expect(pane().reconnecting).toBe(false)
    drain.push(batch(6, a('x', 'late')))
    flush()
    expect(pane().messages.map((m) => m.text)).toEqual(['snap'])
    drain.push(batch(7, a('x', 'next')))
    flush()
    expect(pane().messages.map((m) => m.text)).toEqual(['next'])
    expect(pane().lastSeq).toBe(7)
    expect(requestSnapshot).toHaveBeenCalledTimes(1)
  })

  it('a snapshot that returns null or rejects clears the label and the stash', async () => {
    const { drain, requestSnapshot, flush } = setup()
    drain.push(batch(1, a('x', 'a')))
    flush()
    drain.push(batch(5, a('x', 'gap')))
    expect(pane().reconnecting).toBe(true)
    expect(requestSnapshot).toHaveBeenCalledTimes(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(pane().reconnecting).toBe(false)
    // The stashed gap batch is gone; in-order batches apply again without another snapshot.
    drain.push(batch(2, a('x', 'ab')))
    flush()
    expect(pane().messages.map((m) => m.text)).toEqual(['ab'])
    expect(pane().lastSeq).toBe(2)
    expect(requestSnapshot).toHaveBeenCalledTimes(1)

    requestSnapshot.mockImplementationOnce(() => Promise.reject(new Error('ipc down')))
    drain.push(batch(9, a('x', 'gap2')))
    expect(pane().reconnecting).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(pane().reconnecting).toBe(false)
    drain.push(batch(3, a('x', 'abc')))
    flush()
    expect(pane().messages.map((m) => m.text)).toEqual(['abc'])
    expect(requestSnapshot).toHaveBeenCalledTimes(2)
  })

  it('drops a held batch the snapshot cannot reach instead of resyncing forever', async () => {
    // Main restarted its seq (the pane was reopened on another file) and a late batch from the
    // old process arrives under the same paneId.
    const snapshot: Snapshot = { seq: 0, messages: [], meta, running: false }
    const { drain, requestSnapshot, flush } = setup({ snapshot })
    drain.push(batch(57, a('x', 'stale')))
    expect(requestSnapshot).toHaveBeenCalledTimes(1)
    await new Promise((r) => setTimeout(r, 0))
    flush()
    expect(requestSnapshot).toHaveBeenCalledTimes(1)
    expect(pane().reconnecting).toBe(false)
    expect(pane().lastSeq).toBe(0)
    expect(pane().messages).toEqual([])
    drain.push(batch(1, a('y', 'fresh')))
    flush()
    expect(pane().messages.map((m) => m.text)).toEqual(['fresh'])
    expect(pane().lastSeq).toBe(1)
    expect(requestSnapshot).toHaveBeenCalledTimes(1)
  })

  it('upsert keeps position, appends new ids, and only the changed row changes identity', () => {
    const { drain, flush } = setup()
    drain.push(batch(1, a('a', '1'), a('b', '2'), a('c', '3')))
    flush()
    const before = pane().messages
    drain.push(batch(2, a('b', '2!')))
    flush()
    const after = pane().messages
    expect(after.map((m) => m.text)).toEqual(['1', '2!', '3'])
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[2]).toBe(before[2])
    drain.push(batch(3, a('d', '4')))
    flush()
    expect(pane().messages.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('meta and remove ops update running, error and rows', () => {
    const { drain, flush } = setup()
    drain.push({
      paneId: 'pane-1',
      seq: 1,
      ops: [
        { op: 'upsert', message: a('a', '1') },
        { op: 'meta', patch: { running: true, error: 'boom' } },
      ],
    })
    drain.push({ paneId: 'pane-1', seq: 2, ops: [{ op: 'remove', id: 'a' }] })
    flush()
    expect(pane().messages).toEqual([])
    expect(pane().running).toBe(true)
    expect(pane().error).toBe('boom')
  })
})
