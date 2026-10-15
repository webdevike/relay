import { describe, expect, it, vi } from 'vitest'
import type { Frame } from '@evaos/chat-core/line-framer'
import type { ChatTransport, PromptImage, TransportExit } from '@evaos/chat-core/transport'
import type { Batch } from '@evaos/contract'
import { EOF_ERROR } from '@evaos/chat-core/reducer'
import {
  ALREADY_OWNED,
  MAYBE_RUNNING_ELSEWHERE,
  OWNED_ELSEWHERE,
  STILL_CLOSING,
  SessionManager,
} from './session-manager'

class MemoryTransport implements ChatTransport {
  readonly kind = 'memory'
  started: Array<{ sessionFile: string | null; cwd: string; args?: readonly string[] }> = []
  written: Array<Record<string, unknown>> = []
  sent: string[] = []
  sentImages: Array<readonly PromptImage[] | undefined> = []
  private cb: ((f: Frame) => void) | null = null
  /** When set, start() settles with this promise (models a slow or failing spawn). */
  startGate: Promise<void> | null = null
  start(opts: { sessionFile: string | null; cwd: string; args?: readonly string[] }) {
    this.started.push(opts)
    return this.startGate ?? Promise.resolve()
  }
  /** When set, send() rejects with it (models EPIPE after omp exited). */
  sendError: Error | null = null
  send(text: string, images?: readonly PromptImage[]) {
    if (this.sendError) return Promise.reject(this.sendError)
    this.sent.push(text)
    this.sentImages.push(images)
    return Promise.resolve()
  }
  steer(text: string) {
    return this.send(text)
  }
  abort() {
    return Promise.resolve()
  }
  /** Runs inside write(); lets a test push a frame (an early `_eof`) mid-handshake. */
  writeHook: ((c: Record<string, unknown>) => void) | null = null
  write(c: Record<string, unknown>) {
    this.written.push(c)
    this.writeHook?.(c)
    return Promise.resolve()
  }
  closeCalls = 0
  closeResult: Promise<TransportExit> = Promise.resolve({ code: 0, signal: null, timedOut: false })
  close(): Promise<TransportExit> {
    this.closeCalls += 1
    return this.closeResult
  }
  onFrame(cb: (f: Frame) => void) {
    this.cb = cb
    return () => {
      this.cb = null
    }
  }
  push(f: Frame) {
    this.cb?.(f)
  }
}

const meta = { model: null, thinking: null, contextTokens: null }
const asst = (t: string) => ({ role: 'assistant', content: [{ type: 'text', text: t }] })

function setup(
  opts: {
    firstStartGate?: Promise<void>
    launchArgs?: (h: 'omp' | 'claude') => string[]
    kind?: string
    stat?: (f: string) => number | null
    now?: () => number
  } = {},
) {
  vi.useFakeTimers()
  const transports: MemoryTransport[] = []
  const batches: Batch[] = []
  const mgr = new SessionManager({
    createTransport: () => {
      const t = new MemoryTransport()
      if (transports.length === 0 && opts.firstStartGate) t.startGate = opts.firstStartGate
      if (opts.kind) (t as { kind: string }).kind = opts.kind
      transports.push(t)
      return t
    },
    emit: (b) => batches.push(b),
    cwd: '/eva',
    machineLabel: 'Mac',
    realpath: (f) => f,
    ...(opts.stat ? { stat: opts.stat } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.launchArgs ? { launchArgs: opts.launchArgs } : {}),
  })
  return { mgr, transports, batches }
}

describe('SessionManager', () => {
  describe('shared writers', () => {
    it('refuses an unconfirmed send into a file another pane owns and writes nothing', async () => {
      const { mgr, transports } = setup()
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      mgr.open('pane-2', '/s/a.jsonl', [], meta)
      await mgr.send('pane-2', 'first')
      expect(transports[0]!.sent).toHaveLength(1)
      await expect(mgr.send('pane-1', 'second')).rejects.toMatchObject({
        code: 'owned-elsewhere',
        message: OWNED_ELSEWHERE,
      })
      expect(transports[0]!.sent).toHaveLength(1)
      expect(transports).toHaveLength(1)
      vi.useRealTimers()
    })

    it('a forced send goes through the owner transport and never starts a second process', async () => {
      const { mgr, transports } = setup()
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      mgr.open('pane-2', '/s/a.jsonl', [], meta)
      await mgr.send('pane-2', 'first')
      await mgr.send('pane-1', 'second', { force: true })
      expect(transports).toHaveLength(1)
      expect(transports[0]!.sent).toEqual([
        '<surface>Mac - EvaOS</surface>\nfirst',
        '<surface>Mac - EvaOS</surface>\nsecond',
      ])
      expect(mgr.transportOf('pane-1')).toBeNull()
      expect(mgr.snapshot('pane-2').messages.some((m) => m.text === 'second')).toBe(true)
      vi.useRealTimers()
    })

    it('remembers the choice for later sends from the same pane', async () => {
      const { mgr, transports } = setup()
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      mgr.open('pane-2', '/s/a.jsonl', [], meta)
      await mgr.send('pane-2', 'first')
      await mgr.send('pane-1', 'second', { force: true })
      await mgr.send('pane-1', 'third')
      expect(transports[0]!.sent).toHaveLength(3)
      expect(transports).toHaveLength(1)
      vi.useRealTimers()
    })

    it('drops the memory when the owner changes', async () => {
      const { mgr, transports } = setup()
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      mgr.open('pane-2', '/s/a.jsonl', [], meta)
      mgr.open('pane-3', '/s/a.jsonl', [], meta)
      await mgr.send('pane-2', 'first')
      await mgr.send('pane-1', 'second', { force: true })
      // pane-2's process exits; pane-3 takes the file.
      transports[0]!.push({ type: '_eof', code: 0, signal: null })
      expect(mgr.has('/s/a.jsonl')).toBe(false)
      await mgr.send('pane-3', 'mine')
      expect(transports).toHaveLength(2)
      await expect(mgr.send('pane-1', 'again')).rejects.toMatchObject({ code: 'owned-elsewhere' })
      vi.useRealTimers()
    })

    it('prompts for an unowned file written in the last 10 minutes, then starts a transport on force', async () => {
      const now = 10_000_000
      const { mgr, transports } = setup({ stat: () => now - 60_000, now: () => now })
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      await expect(mgr.send('pane-1', 'hi')).rejects.toMatchObject({
        code: 'owned-elsewhere',
        message: MAYBE_RUNNING_ELSEWHERE,
      })
      expect(transports).toHaveLength(0)
      await mgr.send('pane-1', 'hi', { force: true })
      expect(transports).toHaveLength(1)
      expect(transports[0]!.sent).toHaveLength(1)
      // Now the owner: later sends need no confirmation.
      await mgr.send('pane-1', 'more')
      expect(transports[0]!.sent).toHaveLength(2)
      vi.useRealTimers()
    })

    it('sends without a prompt when the file is older than 10 minutes', async () => {
      const now = 10_000_000
      const { mgr, transports } = setup({ stat: () => now - 11 * 60_000, now: () => now })
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      await mgr.send('pane-1', 'hi')
      expect(transports).toHaveLength(1)
      vi.useRealTimers()
    })

    it('exposes the owner pane through ownerOf', async () => {
      const { mgr } = setup()
      mgr.open('pane-2', '/s/a.jsonl', [], meta)
      expect(mgr.ownerOf('/s/a.jsonl')).toBeNull()
      await mgr.send('pane-2', 'a')
      expect(mgr.ownerOf('/s/a.jsonl')).toBe('pane-2')
      vi.useRealTimers()
    })
  })

  it('send with images maps them to prompt images and echoes them in the row', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'look', { images: [{ mimeType: 'image/png', data: 'AAA' }] })
    const t = transports[0]!
    expect(t.sent).toEqual(['<surface>Mac - EvaOS</surface>\nlook'])
    expect(t.sentImages[0]).toEqual([{ type: 'image', data: 'AAA', mimeType: 'image/png' }])
    const row = mgr.snapshot('pane-1').messages.at(-1)!
    expect(row.images).toEqual([
      { label: 'Image 1', src: 'data:image/png;base64,AAA', mimeType: 'image/png' },
    ])
  })

  it('send without images passes images undefined', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'plain')
    await mgr.send('pane-1', 'empty list', { images: [] })
    expect(transports[0]!.sentImages).toEqual([undefined, undefined])
  })

  it('paneFiles lists bound panes and is live only while a transport exists', async () => {
    const { mgr } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    mgr.openDraft('pane-2', meta)
    expect(mgr.paneFiles()).toEqual([{ paneId: 'pane-1', file: '/s/a.jsonl', live: false }])
    await mgr.send('pane-1', 'hello')
    expect(mgr.paneFiles()).toEqual([{ paneId: 'pane-1', file: '/s/a.jsonl', live: true }])
  })

  it('an image-only send writes one untagged prompt (tagged() leaves blank text alone)', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', '', { images: [{ mimeType: 'image/gif', data: 'BBB' }] })
    const t = transports[0]!
    expect(t.sent).toEqual([''])
    expect(t.sentImages[0]).toHaveLength(1)
  })

  it('a failed image send takes the row back out', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'one')
    transports[0]!.sendError = new Error('EPIPE')
    await expect(
      mgr.send('pane-1', 'two', { images: [{ mimeType: 'image/png', data: 'A' }] }),
    ).rejects.toThrow('EPIPE')
    expect(mgr.snapshot('pane-1').messages.filter((m) => m.images.length > 0)).toHaveLength(0)
  })

  it('starts the transport once on first send, with handshake commands before the prompt', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'hello')
    await mgr.send('pane-1', 'steer me')
    expect(transports).toHaveLength(1)
    const t = transports[0]!
    expect(t.started).toEqual([{ sessionFile: '/s/a.jsonl', cwd: '/eva' }])
    expect(t.written.map((c) => c.type)).toEqual(['set_ask_dialog', 'get_state'])
    expect(t.sent).toEqual([
      '<surface>Mac - EvaOS</surface>\nhello',
      '<surface>Mac - EvaOS</surface>\nsteer me',
    ])
    vi.useRealTimers()
  })

  it('a second send during spawn waits for the same start and keeps prompt order', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { mgr, transports } = setup({ firstStartGate: gate })
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    const p1 = mgr.send('pane-1', 'one')
    const p2 = mgr.send('pane-1', 'two')
    await Promise.resolve()
    expect(transports).toHaveLength(1)
    expect(transports[0]!.sent).toEqual([])
    release()
    await Promise.all([p1, p2])
    expect(transports).toHaveLength(1)
    expect(transports[0]!.written.map((c) => c.type)).toEqual(['set_ask_dialog', 'get_state'])
    expect(transports[0]!.sent).toEqual([
      '<surface>Mac - EvaOS</surface>\none',
      '<surface>Mac - EvaOS</surface>\ntwo',
    ])
    vi.useRealTimers()
  })

  it('both sends during a failed spawn reject with spawn-failed and the pane recovers', async () => {
    const gate = Promise.reject(new Error('ENOENT'))
    gate.catch(() => undefined)
    const { mgr, transports } = setup({ firstStartGate: gate })
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    const p1 = mgr.send('pane-1', 'one')
    const p2 = mgr.send('pane-1', 'two')
    await expect(p1).rejects.toMatchObject({ code: 'spawn-failed' })
    await expect(p2).rejects.toMatchObject({ code: 'spawn-failed' })
    expect(mgr.transportOf('pane-1')).toBeNull()
    expect(mgr.has('/s/a.jsonl')).toBe(false)
    await mgr.send('pane-1', 'three')
    expect(transports).toHaveLength(2)
    expect(transports[1]!.sent).toEqual(['<surface>Mac - EvaOS</surface>\nthree'])
    vi.useRealTimers()
  })

  it('a pane replaced while omp is spawning leaves no timer, no stray batch and one close', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { mgr, transports, batches } = setup({ firstStartGate: gate })
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    const pending = mgr.send('pane-1', 'one')
    await Promise.resolve()
    expect(transports).toHaveLength(1)
    // The user clicks another session before omp is up.
    mgr.open('pane-1', '/s/b.jsonl', [], meta)
    expect(transports[0]!.closeCalls).toBe(1)
    release()
    await expect(pending).rejects.toMatchObject({ code: 'session-closed' })
    await vi.advanceTimersByTimeAsync(100)
    expect(vi.getTimerCount()).toBe(0)
    expect(batches).toEqual([])
    expect(transports[0]!.written).toEqual([])
    expect(transports[0]!.sent).toEqual([])
    // The new pane starts clean at seq 1 on its own process.
    await mgr.send('pane-1', 'two')
    await vi.advanceTimersByTimeAsync(16)
    expect(transports).toHaveLength(2)
    expect(batches.map((b) => b.seq)).toEqual([1])
    vi.useRealTimers()
  })

  it('omp exiting during the handshake rejects the pending send with a code, not a TypeError', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { mgr, transports, batches } = setup({ firstStartGate: gate })
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    const created = () => transports[0]
    const pending = mgr.send('pane-1', 'one')
    await Promise.resolve()
    // omp dies right after the first handshake command is written.
    created()!.writeHook = (c) => {
      if (c.type === 'set_ask_dialog') created()!.push({ type: '_eof', code: 1, signal: null })
    }
    release()
    await expect(pending).rejects.toMatchObject({ code: 'session-closed' })
    expect(created()!.sent).toEqual([])
    expect(mgr.transportOf('pane-1')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    // The exit itself was reported once, as an unexpected end.
    expect(batches).toHaveLength(1)
    expect(batches[0]!.ops.find((o) => o.op === 'meta')).toMatchObject({
      patch: { connected: false, running: false, error: EOF_ERROR },
    })
    vi.useRealTimers()
  })

  it('a failed transport write takes the unconfirmed row back out and rethrows', async () => {
    const { mgr, transports, batches } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'ok')
    await vi.advanceTimersByTimeAsync(16)
    transports[0]!.sendError = new Error('EPIPE')
    await expect(mgr.send('pane-1', 'lost')).rejects.toThrow('EPIPE')
    expect(mgr.snapshot('pane-1').messages.map((m) => m.text)).toEqual(['ok'])
    await vi.advanceTimersByTimeAsync(16)
    const last = batches.at(-1)!
    expect(last.ops.filter((o) => o.op === 'upsert')).toEqual([])
    expect(last.ops.filter((o) => o.op === 'remove').map((o) => o.id)).toEqual(['sent-2'])
    vi.useRealTimers()
  })

  it('emits seq-stamped batches 1, 2, 3 per non-empty 16 ms flush', async () => {
    const { mgr, transports, batches } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'hi')
    const t = transports[0]!
    await vi.advanceTimersByTimeAsync(16)
    expect(batches.map((b) => b.seq)).toEqual([1])
    t.push({ type: 'agent_start' })
    await vi.advanceTimersByTimeAsync(16)
    t.push({ type: 'message_update', messageId: 'm1', message: asst('a') })
    t.push({ type: 'message_update', messageId: 'm1', message: asst('ab') })
    await vi.advanceTimersByTimeAsync(16)
    await vi.advanceTimersByTimeAsync(48)
    expect(batches.map((b) => b.seq)).toEqual([1, 2, 3])
    const last = batches[2]!.ops.filter((o) => o.op === 'upsert')
    expect(last).toHaveLength(1)
    expect(last[0]).toMatchObject({ message: { id: 'm1', text: 'ab' } })
    expect(mgr.snapshot('pane-1').seq).toBe(3)
    vi.useRealTimers()
  })

  it('refuses a second pane on the same session file', async () => {
    const { mgr } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    mgr.open('pane-2', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'one')
    await expect(mgr.send('pane-2', 'two')).rejects.toMatchObject({ code: 'owned-elsewhere' })
    vi.useRealTimers()
  })

  it('writes reducer effects back to the transport', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'hi')
    transports[0]!.push({ type: 'extension_ui_request', id: 'u1', method: 'ask', questions: 'x' })
    expect(transports[0]!.written.at(-1)).toEqual({
      type: 'extension_ui_response',
      id: 'u1',
      cancelled: true,
    })
    vi.useRealTimers()
  })

  it('snapshot returns the reducer messages with the current seq', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'hi')
    transports[0]!.push({ type: 'message_update', messageId: 'm1', message: asst('x') })
    const snap = mgr.snapshot('pane-1')
    expect(snap.messages.map((m) => m.id)).toEqual(['m1', 'sent-1'])
    expect(snap.seq).toBe(0)
    expect(snap.connected).toBe(true)
    expect(snap.error).toBeNull()
    vi.useRealTimers()
  })

  it('send without an opened session is rejected with a code', async () => {
    const { mgr } = setup()
    await expect(mgr.send('pane-1', 'x')).rejects.toMatchObject({ code: 'no-session' })
    vi.useRealTimers()
  })

  it('close() releases ownership, stops flushing and closeAll() closes every pane', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    mgr.open('pane-2', '/s/b.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    await mgr.send('pane-2', 'b')
    expect(mgr.has('/s/a.jsonl')).toBe(true)
    const exit = await mgr.close('pane-1')
    expect(exit).toEqual({ code: 0, signal: null, timedOut: false })
    expect(transports[0]!.closeCalls).toBe(1)
    expect(mgr.has('/s/a.jsonl')).toBe(false)
    expect(await mgr.close('pane-1')).toBeNull()
    await mgr.closeAll()
    expect(transports[1]!.closeCalls).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('an _eof frame from omp detaches the pane: no close(), no second _eof, one final batch', async () => {
    const { mgr, transports, batches } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'hi')
    await vi.advanceTimersByTimeAsync(16)
    const t = transports[0]!
    t.push({ type: '_eof', code: 1, signal: null })
    expect(t.closeCalls).toBe(0)
    expect(mgr.transportOf('pane-1')).toBeNull()
    expect(mgr.has('/s/a.jsonl')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    const last = batches.at(-1)!
    expect(last.seq).toBe(2)
    expect(last.ops.filter((o) => o.op === 'remove').map((o) => o.id)).toEqual(['sent-1'])
    expect(last.ops.find((o) => o.op === 'meta')).toMatchObject({
      patch: { connected: false, running: false, error: EOF_ERROR },
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(batches.at(-1)).toBe(last)
    // A resync after the lost `_eof` batch still learns that omp is gone and why.
    expect(mgr.snapshot('pane-1')).toMatchObject({
      seq: 2,
      messages: [],
      running: false,
      connected: false,
      error: EOF_ERROR,
    })
    // The next send starts a fresh process and takes the EOF error down with it.
    await mgr.send('pane-1', 'again')
    expect(transports).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(16)
    expect(batches.at(-1)!.seq).toBe(3)
    expect(batches.at(-1)!.ops.find((o) => o.op === 'meta')).toMatchObject({
      patch: { connected: true, error: null },
    })
    vi.useRealTimers()
  })

  it('reopening a pane on another file while omp is live never emits under the old seq', async () => {
    const { mgr, transports, batches } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    await vi.advanceTimersByTimeAsync(16)
    expect(batches.map((b) => b.seq)).toEqual([1])
    mgr.open('pane-1', '/s/b.jsonl', [], meta)
    await vi.advanceTimersByTimeAsync(50)
    expect(transports[0]!.closeCalls).toBe(1)
    // The old pane's `_eof` flush (seq 2) must not reach the renderer: it now sits at seq 0.
    expect(batches.map((b) => b.seq)).toEqual([1])
    expect(mgr.snapshot('pane-1').seq).toBe(0)
    expect(mgr.has('/s/a.jsonl')).toBe(false)
    await mgr.send('pane-1', 'b')
    expect(transports).toHaveLength(2)
    expect(transports[1]!.started[0]!.sessionFile).toBe('/s/b.jsonl')
    expect(vi.getTimerCount()).toBe(1)
    vi.useRealTimers()
  })

  it('a send inside the close grace window waits for the previous omp to exit (single writer)', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    await vi.advanceTimersByTimeAsync(16)
    let exited!: (e: TransportExit) => void
    transports[0]!.closeResult = new Promise((r) => {
      exited = r
    })
    const closing = mgr.close('pane-1')
    // omp is still finishing its turn and appending to the session file.
    const pending = mgr.send('pane-1', 'b')
    await vi.advanceTimersByTimeAsync(100)
    expect(transports).toHaveLength(1)
    expect(mgr.has('/s/a.jsonl')).toBe(true)
    exited({ code: 0, signal: null, timedOut: false })
    await closing
    await pending
    expect(transports).toHaveLength(2)
    expect(transports[1]!.sent).toEqual(['<surface>Mac - EvaOS</surface>\nb'])
    expect(mgr.has('/s/a.jsonl')).toBe(true)
    vi.useRealTimers()
  })

  it('switching to another session and back during the grace window waits as well', async () => {
    const { mgr, transports, batches } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    await vi.advanceTimersByTimeAsync(16)
    let exited!: (e: TransportExit) => void
    transports[0]!.closeResult = new Promise((r) => {
      exited = r
    })
    mgr.open('pane-1', '/s/b.jsonl', [], meta)
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    const pending = mgr.send('pane-1', 'back')
    await vi.advanceTimersByTimeAsync(100)
    expect(transports).toHaveLength(1)
    expect(mgr.has('/s/a.jsonl')).toBe(true)
    exited({ code: 0, signal: null, timedOut: false })
    await pending
    expect(transports).toHaveLength(2)
    expect(transports[1]!.started[0]!.sessionFile).toBe('/s/a.jsonl')
    // The replaced pane stayed inert; the fresh pane starts its own seq at 1.
    await vi.advanceTimersByTimeAsync(16)
    expect(batches.map((b) => b.seq)).toEqual([1, 1])
    vi.useRealTimers()
  })

  it('two panes waiting on one closing process: exactly one spawns, the other is refused', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    mgr.open('pane-2', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    await vi.advanceTimersByTimeAsync(16)
    let exited!: (e: TransportExit) => void
    transports[0]!.closeResult = new Promise((r) => {
      exited = r
    })
    const closing = mgr.close('pane-1')
    // Both panes send while the old omp is still finishing its turn (grace window).
    const first = mgr.send('pane-1', 'b')
    const second = mgr.send('pane-2', 'c').then(
      () => null,
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(transports).toHaveLength(1)
    exited({ code: 0, signal: null, timedOut: false })
    await closing
    await first
    // The file is released once; only one waiter may take it (single writer, D-17).
    expect(await second).toMatchObject({ code: 'already-owned', message: ALREADY_OWNED })
    expect(transports).toHaveLength(2)
    expect(transports[1]!.started).toEqual([{ sessionFile: '/s/a.jsonl', cwd: '/eva' }])
    expect(transports[1]!.sent).toEqual(['<surface>Mac - EvaOS</surface>\nb'])
    expect(mgr.transportOf('pane-1')).toBe(transports[1])
    expect(mgr.transportOf('pane-2')).toBeNull()
    expect(mgr.has('/s/a.jsonl')).toBe(true)
    vi.useRealTimers()
  })

  it('a timed-out close keeps the file owned until the process reports its exit', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    transports[0]!.closeResult = Promise.resolve({ code: null, signal: null, timedOut: true })
    await mgr.close('pane-1', 50)
    expect(mgr.has('/s/a.jsonl')).toBe(true)
    await expect(mgr.send('pane-1', 'b')).rejects.toMatchObject({
      code: 'already-owned',
      message: STILL_CLOSING,
    })
    expect(transports).toHaveLength(1)
    // The process finally exits on its own.
    transports[0]!.push({ type: '_eof', code: 0, signal: null })
    expect(mgr.has('/s/a.jsonl')).toBe(false)
    await mgr.send('pane-1', 'c')
    expect(transports).toHaveLength(2)
    vi.useRealTimers()
  })

  it('re-opening the same file in the same pane after a timed-out close reports still closing, not another pane', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    transports[0]!.closeResult = Promise.resolve({ code: null, signal: null, timedOut: true })
    await mgr.close('pane-1', 50)
    // chat.open on the same file replaces the Pane object under the same paneId.
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await expect(mgr.send('pane-1', 'b')).rejects.toMatchObject({
      code: 'already-owned',
      message: STILL_CLOSING,
    })
    expect(transports).toHaveLength(1)
    vi.useRealTimers()
  })

  it('close() on a transport that never exits resolves timedOut and only calls close', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    transports[0]!.closeResult = Promise.resolve({ code: null, signal: null, timedOut: true })
    const abortSpy = vi.spyOn(transports[0]!, 'abort')
    const exit = await mgr.close('pane-1', 50)
    expect(exit).toEqual({ code: null, signal: null, timedOut: true })
    expect(abortSpy).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

const stateFrame = (file: string | null) =>
  ({
    type: 'response',
    command: 'get_state',
    success: true,
    id: 'evaos-state',
    data: { sessionFile: file },
  }) as unknown as Frame
const TAG = '<surface>Mac - EvaOS</surface>\n'

describe('SessionManager new chats and status', () => {
  it('a draft starts omp without a file and with the default launch args', async () => {
    const { mgr, transports } = setup({ launchArgs: (h) => ['--approval-mode', `${h}-x`] })
    mgr.openDraft('pane-1', meta)
    expect(mgr.liveFiles().size).toBe(0)
    await mgr.send('pane-1', 'hi')
    expect(transports[0]!.started).toEqual([
      { sessionFile: null, cwd: '/eva', args: ['--approval-mode', 'omp-x'] },
    ])
    expect(mgr.liveFiles().size).toBe(0)
    vi.useRealTimers()
  })

  it('a claude transport gets the claude default args', async () => {
    const { mgr, transports } = setup({ launchArgs: (h) => [h], kind: 'claude' })
    mgr.openDraft('pane-1', meta)
    await mgr.send('pane-1', 'hi')
    expect(transports[0]!.started[0]!.args).toEqual(['claude'])
    vi.useRealTimers()
  })

  it('a resumed chat does not get the default launch args', async () => {
    const { mgr, transports } = setup({ launchArgs: () => ['--approval-mode', 'yolo'] })
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'hi')
    expect(transports[0]!.started).toEqual([{ sessionFile: '/s/a.jsonl', cwd: '/eva' }])
    vi.useRealTimers()
  })

  it('get_state binds the draft: owner, meta patch and status event', async () => {
    const { mgr, transports, batches } = setup()
    const seen: string[] = []
    mgr.onStatusChange((f) => seen.push(f))
    mgr.openDraft('pane-1', meta)
    await mgr.send('pane-1', 'hi')
    transports[0]!.push(stateFrame('/s/new.jsonl'))
    expect(mgr.ownerOf('/s/new.jsonl')).toBe('pane-1')
    expect([...mgr.liveFiles()]).toEqual(['/s/new.jsonl'])
    expect(seen).toContain('/s/new.jsonl')
    vi.advanceTimersByTime(20)
    const patches = batches.flatMap((b) => b.ops).filter((o) => o.op === 'meta')
    expect(patches.some((o) => o.op === 'meta' && o.patch.sessionFile === '/s/new.jsonl')).toBe(
      true,
    )
    vi.useRealTimers()
  })

  it('a second get_state with the same file does nothing', async () => {
    const { mgr, transports } = setup()
    const seen: string[] = []
    mgr.openDraft('pane-1', meta)
    await mgr.send('pane-1', 'hi')
    transports[0]!.push(stateFrame('/s/new.jsonl'))
    mgr.onStatusChange((f) => seen.push(f))
    transports[0]!.push(stateFrame('/s/new.jsonl'))
    expect(seen).toEqual([])
    vi.useRealTimers()
  })

  it('only an absolute .jsonl path binds', async () => {
    const { mgr, transports } = setup()
    mgr.openDraft('pane-1', meta)
    await mgr.send('pane-1', 'hi')
    for (const bad of ['rel/x.jsonl', '/s/x.txt', null]) transports[0]!.push(stateFrame(bad))
    expect(mgr.liveFiles().size).toBe(0)
    vi.useRealTimers()
  })

  it('a draft that binds to an already owned file keeps the first owner', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    mgr.openDraft('pane-2', meta)
    await mgr.send('pane-2', 'b')
    transports[1]!.push(stateFrame('/s/a.jsonl'))
    expect(mgr.ownerOf('/s/a.jsonl')).toBe('pane-1')
    expect(transports).toHaveLength(2)
    vi.useRealTimers()
  })

  it('tags every send path exactly once', async () => {
    const { mgr, transports } = setup()
    mgr.openDraft('pane-1', meta)
    await mgr.send('pane-1', 'first')
    await mgr.send('pane-1', 'steer while running')
    await mgr.send('pane-1', 'with image', { images: [{ mimeType: 'image/png', data: 'A' }] })
    mgr.open('pane-2', '/s/r.jsonl', [], meta)
    await mgr.send('pane-2', 'resumed')
    expect(transports[0]!.sent).toEqual([
      `${TAG}first`,
      `${TAG}steer while running`,
      `${TAG}with image`,
    ])
    expect(transports[1]!.sent).toEqual([`${TAG}resumed`])
    for (const t of transports)
      for (const m of t.sent) expect(m.split('<surface>').length - 1).toBe(1)
    vi.useRealTimers()
  })

  it('tags a prompt sent through a claude transport', async () => {
    const { mgr, transports } = setup({ kind: 'claude' })
    mgr.openDraft('pane-1', meta)
    await mgr.send('pane-1', 'hello')
    expect(transports[0]!.sent).toEqual([`${TAG}hello`])
    vi.useRealTimers()
  })

  it('liveStatus mirrors working and status events fire on agent_start and agent_end', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    const seen: string[] = []
    mgr.onStatusChange((f) => seen.push(f))
    expect(mgr.liveStatus('/s/a.jsonl')).toEqual({ paneId: 'pane-1', working: false, dialog: null })
    transports[0]!.push({ type: 'agent_start' } as Frame)
    expect(mgr.liveStatus('/s/a.jsonl')?.working).toBe(true)
    transports[0]!.push({ type: 'agent_end', messages: [] } as unknown as Frame)
    expect(mgr.liveStatus('/s/a.jsonl')?.working).toBe(false)
    expect(seen).toEqual(['/s/a.jsonl', '/s/a.jsonl'])
    expect(mgr.liveStatus('/s/none.jsonl')).toBeNull()
    vi.useRealTimers()
  })

  it('an _eof disowns the file and fires a status change', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    const seen: string[] = []
    mgr.onStatusChange((f) => seen.push(f))
    transports[0]!.push({ type: '_eof', code: 1, signal: null } as unknown as Frame)
    expect(mgr.ownerOf('/s/a.jsonl')).toBeNull()
    expect(mgr.liveFiles().size).toBe(0)
    expect(seen).toContain('/s/a.jsonl')
    vi.useRealTimers()
  })

  it('onStatusChange returns an unsubscribe', async () => {
    const { mgr } = setup()
    const seen: string[] = []
    const off = mgr.onStatusChange((f) => seen.push(f))
    off()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    expect(seen).toEqual([])
    vi.useRealTimers()
  })

  it('renameOwned writes set_session_name to the owner and refuses other files', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'a')
    expect(await mgr.renameOwned('/s/a.jsonl', 'Better name')).toBe(true)
    expect(transports[0]!.written.at(-1)).toEqual({ type: 'set_session_name', name: 'Better name' })
    const before = transports[0]!.written.length
    expect(await mgr.renameOwned('/s/other.jsonl', 'x')).toBe(false)
    expect(transports[0]!.written).toHaveLength(before)
    vi.useRealTimers()
  })

  it('closing a bound draft frees its file', async () => {
    const { mgr, transports } = setup()
    mgr.openDraft('pane-1', meta)
    await mgr.send('pane-1', 'hi')
    transports[0]!.push(stateFrame('/s/new.jsonl'))
    await mgr.close('pane-1')
    expect(mgr.ownerOf('/s/new.jsonl')).toBeNull()
    vi.useRealTimers()
  })

  describe('dialogs', () => {
    const selectFrame = {
      type: 'extension_ui_request',
      id: 'u1',
      method: 'select',
      title: 'Pick',
      options: ['A', 'B'],
    } as unknown as Frame

    it('holds a dialog, reports status and includes it in the snapshot', async () => {
      const { mgr, transports } = setup()
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      await mgr.send('pane-1', 'a')
      const seen: string[] = []
      mgr.onStatusChange((f) => seen.push(f))
      transports[0]!.push(selectFrame)
      expect(mgr.liveStatus('/s/a.jsonl')?.dialog).toBe('other')
      expect(seen).toHaveLength(1)
      expect(mgr.snapshot('pane-1').dialog).toMatchObject({ kind: 'select', id: 'u1' })
      expect(transports[0]!.written.at(-1)?.type).not.toBe('extension_ui_response')
      transports[0]!.push({
        type: 'extension_ui_request',
        id: 'u2',
        method: 'confirm',
        title: 'Sure?',
      } as unknown as Frame)
      expect(mgr.liveStatus('/s/a.jsonl')?.dialog).toBe('confirm')
      vi.useRealTimers()
    })

    it('answerUi writes the response, updates the row and clears the dialog', async () => {
      const { mgr, transports, batches } = setup()
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      await mgr.send('pane-1', 'a')
      transports[0]!.push(selectFrame)
      const seen: string[] = []
      mgr.onStatusChange((f) => seen.push(f))
      expect(await mgr.answerUi('pane-1', 'u1', { kind: 'select', value: 'B' })).toBe(true)
      expect(transports[0]!.written.at(-1)).toEqual({
        type: 'extension_ui_response',
        id: 'u1',
        value: 'B',
      })
      expect(mgr.snapshot('pane-1').dialog).toBeNull()
      expect(mgr.snapshot('pane-1').messages.find((m) => m.id === 'dialog-u1')?.text).toBe(
        'Answered: B',
      )
      expect(seen).toHaveLength(1)
      expect(mgr.liveStatus('/s/a.jsonl')?.dialog).toBeNull()
      vi.advanceTimersByTime(20)
      const metas = batches.flatMap((b) => b.ops).filter((o) => o.op === 'meta')
      expect(metas.at(-1)).toMatchObject({ patch: { dialog: null } })
      vi.useRealTimers()
    })

    it('answerUi with a stale or wrong id writes nothing', async () => {
      const { mgr, transports } = setup()
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      await mgr.send('pane-1', 'a')
      const before = transports[0]!.written.length
      expect(await mgr.answerUi('pane-1', 'u1', { kind: 'cancel' })).toBe(false)
      transports[0]!.push(selectFrame)
      expect(await mgr.answerUi('pane-1', 'other', { kind: 'cancel' })).toBe(false)
      expect(await mgr.answerUi('pane-9', 'u1', { kind: 'cancel' })).toBe(false)
      expect(transports[0]!.written).toHaveLength(before)
      expect(mgr.snapshot('pane-1').dialog).not.toBeNull()
      vi.useRealTimers()
    })

    it('abort cancels the pending dialog so omp is never left blocked', async () => {
      const { mgr, transports } = setup()
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      await mgr.send('pane-1', 'a')
      transports[0]!.push(selectFrame)
      expect(await mgr.abort('pane-1')).toBe(true)
      expect(transports[0]!.written.at(-1)).toEqual({
        type: 'extension_ui_response',
        id: 'u1',
        cancelled: true,
      })
      expect(mgr.snapshot('pane-1').dialog).toBeNull()
      vi.useRealTimers()
    })

    it('close with a pending dialog marks it dead and writes no frame after exit', async () => {
      const { mgr, transports } = setup()
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      await mgr.send('pane-1', 'a')
      transports[0]!.push(selectFrame)
      const before = transports[0]!.written.length
      await mgr.close('pane-1')
      expect(transports[0]!.written).toHaveLength(before)
      const snap = mgr.snapshot('pane-1')
      expect(snap.dialog).toBeNull()
      expect(snap.messages.find((m) => m.id === 'dialog-u1')?.text).toBe(
        'This question can no longer be answered.',
      )
      vi.useRealTimers()
    })

    it('an _eof with a pending dialog clears it and fires a status change', async () => {
      const { mgr, transports } = setup()
      mgr.open('pane-1', '/s/a.jsonl', [], meta)
      await mgr.send('pane-1', 'a')
      transports[0]!.push(selectFrame)
      transports[0]!.push({ type: '_eof', code: 1, signal: null } as unknown as Frame)
      expect(mgr.snapshot('pane-1').dialog).toBeNull()
      vi.useRealTimers()
    })
  })
})
