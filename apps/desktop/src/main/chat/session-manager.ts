import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseFrame } from '@evaos/chat-core/frames'
import { cmd } from '@evaos/chat-core/frames'
import { LiveReducer } from '@evaos/chat-core/reducer'
import { SeqBatcher, type Batch, type Snapshot } from '@evaos/chat-core/batcher'
import type { ChatMessage, SessionMeta } from '@evaos/chat-core/message'
import { tagged } from '@evaos/chat-core/tagged'
import type { ChatTransport, PromptImage, TransportExit } from '@evaos/chat-core/transport'

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
export const STILL_CLOSING =
  'The previous omp process for this session is still running. Wait for it to exit before sending again.'

export interface SessionManagerDeps {
  createTransport: () => ChatTransport
  emit: (batch: Batch) => void
  cwd: string
  machineLabel: string
  intervalMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  realpath?: (file: string) => string
  /** Default launch flags for a new chat (approval from omp config); extended per pane later. */
  launchArgs?: (harness: 'omp' | 'claude') => string[]
}

/** What the chat list, writers and rename need to know about a file this app owns. */
export interface LiveStatus {
  paneId: string
  working: boolean
  dialog: 'confirm' | 'other' | null
}

interface Pane {
  paneId: string
  /** Null for a draft until omp reports the session file it created. */
  file: string | null
  key: string | null
  reducer: LiveReducer
  batcher: SeqBatcher
  transport: ChatTransport | null
  /** In-flight startTransport(); a second send during spawn awaits it instead of writing early. */
  starting: Promise<void> | null
  unsubscribe: (() => void) | null
  timer: unknown
  framesIn: number
  batches: number
}

/**
 * The omp process writing one session file (single writer, D-17). Held from spawn until the
 * process has exited: a close() in flight keeps it, so a send during the grace window waits
 * instead of starting a second writer on the same file.
 */
interface Owner {
  pane: Pane
  transport: ChatTransport
  closing: Promise<TransportExit | null> | null
}

/** Per-pane live sessions: applies omp frames in order and emits seq-stamped 16 ms batches. */
export class SessionManager {
  private panes = new Map<string, Pane>()
  /** realpath of a session file -> the process that owns it. */
  private owners = new Map<string, Owner>()
  private setIv: (fn: () => void, ms: number) => unknown
  private clearIv: (h: unknown) => void
  private real: (f: string) => string
  private statusListeners = new Set<(file: string) => void>()

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
      starting: null,
      unsubscribe: null,
      timer: null,
      framesIn: 0,
      batches: 0,
    })
  }

  /** A new chat: no file yet. The first send starts omp without --resume and binds on get_state. */
  openDraft(paneId: string, meta: SessionMeta): void {
    const existing = this.panes.get(paneId)
    if (existing?.transport) void this.release(existing)
    this.panes.set(paneId, {
      paneId,
      file: null,
      key: null,
      reducer: new LiveReducer([], meta),
      batcher: new SeqBatcher(paneId),
      transport: null,
      starting: null,
      unsubscribe: null,
      timer: null,
      framesIn: 0,
      batches: 0,
    })
  }

  /** The pane whose omp owns this session file, else null. */
  ownerOf(file: string): string | null {
    return this.owners.get(this.real(file))?.pane.paneId ?? null
  }

  /** Realpaths of every session file with a live owner. */
  liveFiles(): ReadonlySet<string> {
    return new Set(this.owners.keys())
  }

  liveStatus(file: string): LiveStatus | null {
    const owner = this.owners.get(this.real(file))
    if (!owner) return null
    // The dialog stays null until the question slice lands.
    return { paneId: owner.pane.paneId, working: owner.pane.reducer.running, dialog: null }
  }

  /** Fires with the owned file's realpath on owner add or remove, working toggle and bind. */
  onStatusChange(cb: (file: string) => void): () => void {
    this.statusListeners.add(cb)
    return () => {
      this.statusListeners.delete(cb)
    }
  }

  private notify(key: string | null): void {
    if (key === null) return
    for (const cb of [...this.statusListeners]) {
      try {
        cb(key)
      } catch {
        // a listener must not break frame handling
      }
    }
  }

  /** Renames through the owning process (single writer): false when this app does not own it. */
  async renameOwned(file: string, name: string): Promise<boolean> {
    const owner = this.owners.get(this.real(file))
    if (!owner) return false
    await owner.transport.write({ type: 'set_session_name', name })
    return true
  }

  has(file: string): boolean {
    return this.owners.has(this.real(file))
  }

  private pane(paneId: string): Pane {
    const p = this.panes.get(paneId)
    if (!p) throw new CodedError('no-session', 'Open a session before sending a message.')
    return p
  }

  async send(
    paneId: string,
    text: string,
    opts: { images?: ReadonlyArray<{ mimeType: string; data: string }> } = {},
  ): Promise<void> {
    const pane = this.pane(paneId)
    if (pane.starting) await pane.starting
    else if (!pane.transport) {
      pane.starting = this.startTransport(pane).finally(() => {
        pane.starting = null
      })
      await pane.starting
    }
    // The pane may have been closed, replaced or lost its process while the start was awaited.
    const transport = pane.transport
    if (!transport) throw new CodedError('session-closed', 'The session is not running.')
    // sendPrompt() runs outside apply(), so its meta change (clearing an EOF error) is diffed here.
    const hadError = pane.reducer.error !== null
    const wasWorking = pane.reducer.running
    const row = pane.reducer.sendPrompt(text, opts.images)
    if (pane.reducer.running !== wasWorking) this.notify(pane.key)
    if (hadError) pane.batcher.markMeta({ error: null })
    pane.batcher.markUpsert(row, pane.reducer.indexOf(row.id))
    try {
      const images: PromptImage[] | undefined =
        opts.images && opts.images.length > 0
          ? opts.images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))
          : undefined
      await transport.send(tagged(text, this.deps.machineLabel), images)
    } catch (e) {
      // omp never received the prompt (EPIPE after exit, for example): take the row back out
      // so it does not sit there unconfirmed forever.
      pane.reducer.dropUnconfirmedRow(row.id)
      pane.batcher.markRemove(row.id)
      throw e
    }
  }

  /**
   * Waits for a previous process on the same file to finish closing, then claims the file for a
   * new transport. The free check and the claim run in one synchronous step (no await between
   * them), so two panes released by the same close cannot both find the file free: the second
   * is refused with `already-owned` (another pane's live process, or one whose close timed out
   * and is still running). A pane replaced while it waited never claims.
   */
  private async acquire(pane: Pane): Promise<ChatTransport> {
    if (pane.key === null) {
      // An unbound draft has no file to collide on: the owner is registered when omp reports it.
      if (this.panes.get(pane.paneId) !== pane) {
        throw new CodedError('session-closed', 'The session was closed before omp started.')
      }
      return this.deps.createTransport()
    }
    const key = pane.key
    for (;;) {
      const owner = this.owners.get(key)
      if (owner?.closing) {
        await owner.closing
        continue
      }
      if (this.panes.get(pane.paneId) !== pane) {
        throw new CodedError('session-closed', 'The session was closed before omp started.')
      }
      if (owner) {
        // By paneId, not pane object: open() replaces the Pane, but the same pane's own omp
        // still exiting after a timed-out close is "still closing", not "another pane".
        throw new CodedError(
          'already-owned',
          owner.pane.paneId === pane.paneId ? STILL_CLOSING : ALREADY_OWNED,
        )
      }
      const transport = this.deps.createTransport()
      this.owners.set(key, { pane, transport, closing: null })
      this.notify(key)
      return transport
    }
  }

  private disown(key: string | null, transport: ChatTransport): void {
    if (key === null) return
    if (this.owners.get(key)?.transport === transport) {
      this.owners.delete(key)
      this.notify(key)
    }
  }

  /** Realpath of a file omp is about to create: its directory is resolved when the file is not there yet. */
  private realNew(file: string): string {
    const direct = this.real(file)
    if (direct !== file) return direct
    return path.join(this.real(path.dirname(file)), path.basename(file))
  }

  /**
   * A draft's `get_state` reports the session file omp created. Bind the pane to it and register
   * the owner. Only an absolute `.jsonl` path is accepted (T-04-31). When another pane already
   * owns that file the draft keeps running unregistered: no second owner, no second process.
   */
  private bindDraft(pane: Pane, transport: ChatTransport, raw: Record<string, unknown>): void {
    if (pane.key !== null || raw.type !== 'response' || raw.command !== 'get_state') return
    if (raw.success === false) return
    const data = raw.data
    const file =
      typeof data === 'object' && data !== null
        ? (data as Record<string, unknown>).sessionFile
        : undefined
    if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.jsonl')) return
    const key = this.realNew(file)
    if (this.owners.has(key)) return
    pane.file = file
    pane.key = key
    this.owners.set(key, { pane, transport, closing: null })
    pane.batcher.markMeta({ sessionFile: file })
    this.notify(key)
  }

  private async startTransport(pane: Pane): Promise<void> {
    const transport = await this.acquire(pane)
    pane.transport = transport
    pane.unsubscribe = transport.onFrame((f) => this.onFrame(pane, transport, f))
    try {
      const harness = transport.kind === 'claude' ? 'claude' : 'omp'
      // A resumed chat keeps the session's own launch choices; only a new chat gets the defaults.
      const args = pane.key === null ? this.deps.launchArgs?.(harness) : undefined
      await transport.start({
        sessionFile: pane.key,
        cwd: this.deps.cwd,
        ...(args ? { args } : {}),
      })
    } catch (e) {
      pane.unsubscribe?.()
      pane.unsubscribe = null
      pane.transport = null
      this.disown(pane.key, transport)
      throw new CodedError(
        'spawn-failed',
        `Could not start omp: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    // `open()` on another file, `close()` or an early `_eof` may have detached this pane while
    // the spawn was awaited. The detach already handed the process to close() (or it is gone),
    // so the only thing left is to not install a timer or write a handshake on its behalf.
    const stillMine = (): boolean =>
      pane.transport === transport && this.panes.get(pane.paneId) === pane
    if (!stillMine()) {
      throw new CodedError('session-closed', 'The session was closed before omp started.')
    }
    pane.timer = this.setIv(() => this.flush(pane), this.deps.intervalMs ?? 16)
    pane.batcher.markMeta({ connected: true })
    await transport.write(cmd.setAskDialog('evaos-ask')).catch(() => undefined)
    await transport.write(cmd.getState('evaos-state')).catch(() => undefined)
    if (!stillMine()) {
      throw new CodedError('session-closed', 'The session ended while it was starting.')
    }
  }

  /** Applied synchronously, one frame at a time: there is no await between reading and applying. */
  private onFrame(
    pane: Pane,
    transport: ChatTransport,
    raw: Record<string, unknown> & { type: string },
  ): void {
    pane.framesIn += 1
    const parsed = parseFrame(raw)
    const frame =
      parsed.type === 'unknown' ? raw : (parsed as Record<string, unknown> & { type: string })
    const wasWorking = pane.reducer.running
    const res = pane.reducer.apply(frame)
    for (const id of res.dirty) {
      const ix = pane.reducer.indexOf(id)
      if (ix >= 0) pane.batcher.markUpsert(pane.reducer.messages()[ix]!, ix)
    }
    for (const id of res.removed) pane.batcher.markRemove(id)
    if (res.meta) pane.batcher.markMeta(res.meta)
    this.bindDraft(pane, transport, frame)
    if (pane.reducer.running !== wasWorking) this.notify(pane.key)
    if (res.effect) void pane.transport?.write(res.effect).catch(() => undefined)
    if (frame.type === '_eof') {
      // omp is already gone: nothing to close() and no second `_eof` to apply.
      pane.batcher.markMeta({ connected: false, running: false })
      this.flush(pane)
      this.disown(pane.key, transport)
      this.detach(pane)
    }
  }

  /**
   * Stops the flush timer and forgets the transport; never touches the process itself and
   * leaves file ownership alone (the process may still be writing until it exits).
   */
  private detach(pane: Pane): void {
    if (pane.timer !== null) this.clearIv(pane.timer)
    pane.timer = null
    pane.unsubscribe?.()
    pane.unsubscribe = null
    pane.transport = null
  }

  private flush(pane: Pane): void {
    const batch = pane.batcher.flush()
    if (!batch) return
    pane.batches += 1
    this.deps.emit(batch)
  }

  /**
   * Ends stdin and waits for omp to exit. Never signals (D-17). A timeout leaves the process
   * alone. The pane keeps its history and the next send starts a new process, but only once
   * this one has exited: the file stays owned through the close and, after a timeout, until
   * the process reports its `_eof`.
   */
  private async release(pane: Pane, timeoutMs = 2000): Promise<TransportExit | null> {
    const t = pane.transport
    if (!t) return null
    this.detach(pane)
    const current = pane.key === null ? undefined : this.owners.get(pane.key)
    const held = current?.transport === t ? current : null
    const done = t
      .close({ timeoutMs })
      .then(
        (e): TransportExit | null => e,
        (): TransportExit | null => null,
      )
      .then((exit) => {
        if (held) {
          held.closing = null
          if (exit && !exit.timedOut) this.disown(pane.key, t)
          else {
            // Still running (or unknown): keep the file until the process itself ends.
            const off = t.onFrame((f) => {
              if (f.type !== '_eof') return
              off()
              this.disown(pane.key, t)
            })
          }
        }
        return exit
      })
    if (held) held.closing = done
    const exit = await done
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
      {
        running: p.reducer.running,
        connected: p.transport !== null,
        error: p.reducer.error,
      },
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
