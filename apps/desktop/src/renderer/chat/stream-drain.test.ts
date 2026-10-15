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

function setup(
  opts: {
    snapshot?: Snapshot
    minReconnectMs?: number
    setTimeout?: (fn: () => void, ms: number) => unknown
    now?: () => number
  } = {},
) {
  chatStore.setState({ panes: {} })
  chatStore.getState().openPane('pane-1', { file: '/f', title: 't', messages: [], meta })
  let tick: (() => void) | null = null
  const raf = vi.fn((cb: () => void) => {
    tick = cb
  })
  const requestSnapshot = vi.fn(() => Promise.resolve(opts.snapshot ?? null))
  const drain = createStreamDrain({
    store: chatStore,
    raf,
    requestSnapshot,
    minReconnectMs: opts.minReconnectMs ?? 0,
    setTimeout: opts.setTimeout,
    now: opts.now,
  })
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
    const snapshot: Snapshot = {
      seq: 6,
      messages: [a('x', 'snap')],
      meta,
      running: true,
      connected: true,
      error: null,
    }
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
    const snapshot: Snapshot = {
      seq: 0,
      messages: [],
      meta,
      running: false,
      connected: true,
      error: null,
    }
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

  it('a snapshot taken after omp exited restores the stopped state and the EOF banner', async () => {
    // The dropped batch was the `_eof` one (connected: false, error): the snapshot must carry both.
    const snapshot: Snapshot = {
      seq: 3,
      messages: [a('x', 'done')],
      meta,
      running: false,
      connected: false,
      error: 'The session ended unexpectedly.',
    }
    const { drain, flush } = setup({ snapshot })
    drain.push(batch(1, a('x', 'd')))
    flush()
    expect(pane().stopped).toBe(false)
    drain.push(batch(3, a('x', 'late')))
    await new Promise((r) => setTimeout(r, 0))
    flush()
    expect(pane().lastSeq).toBe(3)
    expect(pane().running).toBe(false)
    expect(pane().stopped).toBe(true)
    expect(pane().error).toBe('The session ended unexpectedly.')
    expect(pane().messages.map((m) => m.text)).toEqual(['done'])
  })

  it('a resync does not bring back the error banner the user dismissed by typing', async () => {
    const EOF = 'The session ended unexpectedly.'
    const snapshot: Snapshot = {
      seq: 3,
      messages: [],
      meta,
      running: false,
      connected: false,
      error: EOF,
    }
    const { drain, flush } = setup({ snapshot })
    drain.push({
      paneId: 'pane-1',
      seq: 1,
      ops: [{ op: 'meta', patch: { connected: false, error: EOF } }],
    })
    flush()
    expect(pane().error).toBe(EOF)
    // The user starts typing: the banner goes, but main still holds the error.
    chatStore.getState().dismissError('pane-1')
    expect(pane().error).toBeNull()
    // A gap before Enter is pressed resyncs from a snapshot that still carries the same text.
    drain.push(batch(3))
    await new Promise((r) => setTimeout(r, 0))
    flush()
    expect(pane().lastSeq).toBe(3)
    expect(pane().stopped).toBe(true)
    expect(pane().error).toBeNull()
    // A new error from main (a batch, or a snapshot with other text) shows again.
    drain.push({ paneId: 'pane-1', seq: 4, ops: [{ op: 'meta', patch: { error: EOF } }] })
    flush()
    expect(pane().error).toBe(EOF)
    expect(pane().dismissedError).toBeNull()
    chatStore.getState().setError('pane-1', null)
    expect(pane().dismissedError).toBeNull()
  })

  it('a stale deferred label clear does not take down a later resync, nor fire after dispose', async () => {
    const timers: Array<() => void> = []
    const snapshot: Snapshot = {
      seq: 5,
      messages: [],
      meta,
      running: true,
      connected: true,
      error: null,
    }
    const { drain, flush } = setup({
      snapshot,
      minReconnectMs: 400,
      now: () => 0,
      setTimeout: (fn) => timers.push(fn),
    })
    drain.push(batch(1, a('x', 'a')))
    flush()
    drain.push(batch(3, a('x', 'gap')))
    await new Promise((r) => setTimeout(r, 0))
    expect(timers).toHaveLength(1)
    // The first snapshot has landed; before its label timer fires a second gap starts a new resync.
    drain.push(batch(9, a('x', 'gap again')))
    expect(pane().reconnecting).toBe(true)
    timers[0]!()
    expect(pane().reconnecting).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(timers).toHaveLength(2)
    drain.dispose()
    timers[1]!()
    expect(pane().reconnecting).toBe(true)
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
