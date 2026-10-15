import { describe, expect, it, vi } from 'vitest'
import type { Frame } from '@evaos/chat-core/line-framer'
import type { ChatTransport, TransportExit } from '@evaos/chat-core/transport'
import type { Batch } from '@evaos/contract'
import { EOF_ERROR } from '@evaos/chat-core/reducer'
import { ALREADY_OWNED, STILL_CLOSING, SessionManager } from './session-manager'

class MemoryTransport implements ChatTransport {
  readonly kind = 'memory'
  started: Array<{ sessionFile: string; cwd: string }> = []
  written: Array<Record<string, unknown>> = []
  sent: string[] = []
  private cb: ((f: Frame) => void) | null = null
  /** When set, start() settles with this promise (models a slow or failing spawn). */
  startGate: Promise<void> | null = null
  start(opts: { sessionFile: string; cwd: string }) {
    this.started.push(opts)
    return this.startGate ?? Promise.resolve()
  }
  /** When set, send() rejects with it (models EPIPE after omp exited). */
  sendError: Error | null = null
  send(text: string) {
    if (this.sendError) return Promise.reject(this.sendError)
    this.sent.push(text)
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

function setup(opts: { firstStartGate?: Promise<void> } = {}) {
  vi.useFakeTimers()
  const transports: MemoryTransport[] = []
  const batches: Batch[] = []
  const mgr = new SessionManager({
    createTransport: () => {
      const t = new MemoryTransport()
      if (transports.length === 0 && opts.firstStartGate) t.startGate = opts.firstStartGate
      transports.push(t)
      return t
    },
    emit: (b) => batches.push(b),
    cwd: '/eva',
    machineLabel: 'Mac',
    realpath: (f) => f,
  })
  return { mgr, transports, batches }
}

describe('SessionManager', () => {
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
    await expect(mgr.send('pane-2', 'two')).rejects.toMatchObject({ code: 'already-owned' })
    vi.useRealTimers()
  })

  it('writes reducer effects back to the transport', async () => {
    const { mgr, transports } = setup()
    mgr.open('pane-1', '/s/a.jsonl', [], meta)
    await mgr.send('pane-1', 'hi')
    transports[0]!.push({ type: 'extension_ui_request', id: 'u1', method: 'confirm' })
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
