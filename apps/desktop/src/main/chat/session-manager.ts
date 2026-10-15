import * as fs from 'node:fs'
import { parseFrame } from '@evaos/chat-core/frames'
import { cmd } from '@evaos/chat-core/frames'
import { LiveReducer } from '@evaos/chat-core/reducer'
import { SeqBatcher, type Batch, type Snapshot } from '@evaos/chat-core/batcher'
import type { ChatMessage, SessionMeta } from '@evaos/chat-core/message'
import { tagged } from '@evaos/chat-core/tagged'
import type { ChatTransport, TransportExit } from '@evaos/chat-core/transport'

export class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const ALREADY_OWNED =
  'This session is already open in another EvaOS window or pane. Close it there first.'

export interface SessionManagerDeps {
  createTransport: () => ChatTransport
  emit: (batch: Batch) => void
  cwd: string
  machineLabel: string
  intervalMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  realpath?: (file: string) => string
}

interface Pane {
  paneId: string
  file: string
  key: string
  reducer: LiveReducer
  batcher: SeqBatcher
  transport: ChatTransport | null
  unsubscribe: (() => void) | null
  timer: unknown
  framesIn: number
  batches: number
}

/** Per-pane live sessions: applies omp frames in order and emits seq-stamped 16 ms batches. */
export class SessionManager {
  private panes = new Map<string, Pane>()
  /** realpath of a session file -> pane that owns its omp process (single writer, D-17). */
  private owners = new Map<string, string>()
  private setIv: (fn: () => void, ms: number) => unknown
  private clearIv: (h: unknown) => void
  private real: (f: string) => string

  constructor(private deps: SessionManagerDeps) {
    this.setIv = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.clearIv = deps.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout))
    this.real =
      deps.realpath ??
      ((f) => {
        try {
          return fs.realpathSync(f)
        } catch {
          return f
        }
      })
  }

  open(paneId: string, file: string, history: ChatMessage[], meta: SessionMeta): void {
    const key = this.real(file)
    const existing = this.panes.get(paneId)
    if (existing?.transport) {
      // A live session keeps its reducer when the same file is opened again.
      if (existing.key === key) return
      void this.release(existing)
    }
    this.panes.set(paneId, {
      paneId,
      file,
      key,
      reducer: new LiveReducer(history, meta),
      batcher: new SeqBatcher(paneId),
      transport: null,
      unsubscribe: null,
      timer: null,
      framesIn: 0,
      batches: 0,
    })
  }

  has(file: string): boolean {
    return this.owners.has(this.real(file))
  }

  private pane(paneId: string): Pane {
    const p = this.panes.get(paneId)
    if (!p) throw new CodedError('no-session', 'Open a session before sending a message.')
    return p
  }

  async send(paneId: string, text: string): Promise<void> {
    const pane = this.pane(paneId)
    if (!pane.transport) await this.startTransport(pane)
    const row = pane.reducer.sendPrompt(text)
    pane.batcher.markUpsert(row, pane.reducer.indexOf(row.id))
    await pane.transport!.send(tagged(text, this.deps.machineLabel))
  }

  private async startTransport(pane: Pane): Promise<void> {
    const owner = this.owners.get(pane.key)
    if (owner !== undefined && owner !== pane.paneId) {
      throw new CodedError('already-owned', ALREADY_OWNED)
    }
    this.owners.set(pane.key, pane.paneId)
    const transport = this.deps.createTransport()
    pane.transport = transport
    pane.unsubscribe = transport.onFrame((f) => this.onFrame(pane, f))
    try {
      await transport.start({ sessionFile: pane.key, cwd: this.deps.cwd })
    } catch (e) {
      pane.unsubscribe?.()
      pane.unsubscribe = null
      pane.transport = null
      this.owners.delete(pane.key)
      throw new CodedError(
        'spawn-failed',
        `Could not start omp: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    pane.timer = this.setIv(() => this.flush(pane), this.deps.intervalMs ?? 16)
    pane.batcher.markMeta({ connected: true })
    await transport.write(cmd.setAskDialog('evaos-ask')).catch(() => undefined)
    await transport.write(cmd.getState('evaos-state')).catch(() => undefined)
  }

  /** Applied synchronously, one frame at a time: there is no await between reading and applying. */
  private onFrame(pane: Pane, raw: Record<string, unknown> & { type: string }): void {
    pane.framesIn += 1
    const parsed = parseFrame(raw)
    const frame =
      parsed.type === 'unknown' ? raw : (parsed as Record<string, unknown> & { type: string })
    const res = pane.reducer.apply(frame)
    for (const id of res.dirty) {
      const ix = pane.reducer.indexOf(id)
      if (ix >= 0) pane.batcher.markUpsert(pane.reducer.messages()[ix]!, ix)
    }
    for (const id of res.removed) pane.batcher.markRemove(id)
    if (res.meta) pane.batcher.markMeta(res.meta)
    if (res.effect) void pane.transport?.write(res.effect).catch(() => undefined)
    if (frame.type === '_eof') {
      pane.batcher.markMeta({ connected: false })
      this.flush(pane)
      void this.release(pane)
    }
  }

  private flush(pane: Pane): void {
    const batch = pane.batcher.flush()
    if (!batch) return
    pane.batches += 1
    this.deps.emit(batch)
  }

  /**
   * Ends stdin and waits for omp to exit. Never signals (D-17). A timeout leaves the process
   * alone. The pane keeps its history and the next send starts a new process.
   */
  private async release(pane: Pane, timeoutMs = 2000): Promise<TransportExit | null> {
    const t = pane.transport
    if (!t) return null
    if (pane.timer !== null) this.clearIv(pane.timer)
    pane.timer = null
    pane.unsubscribe?.()
    pane.unsubscribe = null
    pane.transport = null
    if (this.owners.get(pane.key) === pane.paneId) this.owners.delete(pane.key)
    let exit: TransportExit | null = null
    try {
      exit = await t.close({ timeoutMs })
    } catch {
      exit = null
    }
    // Only the pane still registered under this id may apply `_eof` and emit. A pane replaced
    // by `open()` on another file while omp was live must stay inert: its batcher's seq is
    // ahead of the new one and a late batch under the same paneId would strand the renderer.
    if (this.panes.get(pane.paneId) !== pane) return exit
    if (exit && !exit.timedOut) {
      // Our own unsubscribe means no `_eof` frame reached the reducer: apply it here.
      const res = pane.reducer.apply({
        type: '_eof',
        code: exit.code,
        signal: exit.signal,
        expected: true,
      })
      for (const id of res.dirty) {
        const ix = pane.reducer.indexOf(id)
        if (ix >= 0) pane.batcher.markUpsert(pane.reducer.messages()[ix]!, ix)
      }
      for (const id of res.removed) pane.batcher.markRemove(id)
      if (res.meta) pane.batcher.markMeta(res.meta)
      pane.batcher.markMeta({ connected: false, running: false })
      this.flush(pane)
    }
    return exit
  }

  /** `chat.close`: ends stdin and waits up to `timeoutMs` for exit (CHAT-07). */
  async close(paneId: string, timeoutMs = 10_000): Promise<TransportExit | null> {
    const pane = this.panes.get(paneId)
    if (!pane?.transport) return null
    return this.release(pane, timeoutMs)
  }

  /** Returns whether an abort command was written (false for unknown panes or stopped sessions). */
  async abort(paneId: string): Promise<boolean> {
    const t = this.panes.get(paneId)?.transport
    if (!t) return false
    await t.abort().catch(() => undefined)
    return true
  }

  snapshot(paneId: string): Snapshot {
    const p = this.pane(paneId)
    return p.batcher.snapshot(
      p.reducer.messages().slice(),
      { ...p.reducer.meta() },
      p.reducer.running,
    )
  }

  stats(paneId: string): { batches: number; lastSeq: number; framesIn: number } {
    const p = this.pane(paneId)
    return { batches: p.batches, lastSeq: p.batcher.currentSeq, framesIn: p.framesIn }
  }

  /** The pane's transport, for e2e stats. */
  transportOf(paneId: string): ChatTransport | null {
    return this.panes.get(paneId)?.transport ?? null
  }

  /** Quit hook: ends stdin on every live omp this app started. Never signals (D-17). */
  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.panes.values()].filter((p) => p.transport).map((p) => this.release(p, 10_000)),
    )
  }
}
