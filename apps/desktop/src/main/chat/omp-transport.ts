import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { cmd } from '@evaos/chat-core/frames'
import { LineFramer, type Frame } from '@evaos/chat-core/line-framer'
import type { ChatTransport, TransportExit } from '@evaos/chat-core/transport'
import { resolveSpawnPath } from './shell-path'

export interface OmpTransportOptions {
  ompBin: string
  live: boolean
  /** Extra env for the next spawn only (e2e `setFakeEnv`). */
  takeExtraEnv?: () => Record<string, string>
}

function nodeOnPath(spawnPath: string): boolean {
  return spawnPath.split(path.delimiter).some((d) => {
    try {
      return d !== '' && fs.statSync(path.join(d, 'node')).isFile()
    } catch {
      return false
    }
  })
}

/**
 * omp `--mode rpc-ui` over stdio (protocol v1). One JSON object per line in each direction.
 * Never signals the child: closing stdin is the only way this transport ends it (D-17).
 */
export class OmpStdioTransport implements ChatTransport {
  readonly kind = 'omp-stdio'
  spawnArgs: string[] = []
  spawnCwd = ''
  pid: number | null = null
  private child: ChildProcess | null = null
  private listeners = new Set<(f: Frame) => void>()
  private counter = 0
  private exit: Promise<TransportExit> | null = null
  /** The in-flight start(); close() waits on it so a close requested mid-spawn still ends stdin. */
  private started: Promise<void> | null = null
  private closing = false

  constructor(private opts: OmpTransportOptions) {}

  onFrame(cb: (f: Frame) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private emit(f: Frame): void {
    for (const cb of [...this.listeners]) cb(f)
  }

  start(opts: { sessionFile: string; cwd: string }): Promise<void> {
    if (this.started) return Promise.reject(new Error('transport already started'))
    this.started = this.launch(opts)
    return this.started
  }

  private async launch(opts: { sessionFile: string; cwd: string }): Promise<void> {
    const spawnPath = await resolveSpawnPath(this.opts.live)
    const args = ['--mode', 'rpc-ui', '--resume', opts.sessionFile]
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: spawnPath,
      ...(this.opts.takeExtraEnv?.() ?? {}),
    }
    let bin = this.opts.ompBin
    let argv = args
    if (bin.endsWith('.mjs') && !nodeOnPath(spawnPath)) {
      argv = [bin, ...args]
      bin = process.execPath
      env.ELECTRON_RUN_AS_NODE = '1'
    }
    this.spawnArgs = args
    this.spawnCwd = opts.cwd
    const child = spawn(bin, argv, { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child

    const framer = new LineFramer(
      (f) => this.emit(f),
      () => {
        /* a bad line never drops its neighbours */
      },
    )
    child.stdout!.on('data', (chunk: Buffer) => framer.push(chunk))
    const dec = new StringDecoder('utf8')
    let carry = ''
    child.stderr!.on('data', (chunk: Buffer) => {
      carry += dec.write(chunk)
      let i: number
      while ((i = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, i)
        carry = carry.slice(i + 1)
        this.emit({ type: '_stderr', line })
      }
    })
    child.stdin!.on('error', () => {
      /* EPIPE after exit: the _eof frame reports it */
    })

    // `_eof` is emitted from exactly one place. A spawn that fails (ENOENT, EACCES) emits
    // `error` and then `close` (verified on Node 24), so the `close` handler covers that case
    // too; a second `_eof` from the `error` handler would reach the reducer while start() is
    // still rejecting and race the caller's own cleanup.
    let eofSent = false
    this.exit = new Promise<TransportExit>((resolve) => {
      child.once('close', (code, signal) => {
        framer.end()
        if (carry !== '') this.emit({ type: '_stderr', line: carry })
        if (!eofSent) {
          eofSent = true
          this.emit({ type: '_eof', code, signal, expected: this.closing })
        }
        resolve({ code, signal, timedOut: false })
      })
    })

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => {
        this.pid = child.pid ?? null
        resolve()
      })
      child.once('error', (e) => reject(e))
    })
  }

  write(command: Record<string, unknown>): Promise<void> {
    const out = { ...command }
    if (out.id === undefined) out.id = `evaos-${++this.counter}`
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(new Error('The session is not running.'))
    }
    return new Promise((resolve, reject) => {
      stdin.write(JSON.stringify(out) + '\n', (e) => (e ? reject(e) : resolve()))
    })
  }

  send(text: string): Promise<void> {
    return this.write(cmd.prompt(`evaos-${++this.counter}`, text))
  }

  // Rust behaviour: every prompt carries streamingBehavior 'steer', so a mid-turn prompt is a steer.
  steer(text: string): Promise<void> {
    return this.send(text)
  }

  abort(): Promise<void> {
    return this.write(cmd.abort(`evaos-${++this.counter}`))
  }

  async close(opts?: { timeoutMs?: number }): Promise<TransportExit> {
    this.closing = true
    // A close requested while start() is still spawning waits for the child, so the process is
    // ended (stdin EOF) rather than left running with nobody holding it. A failed start leaves
    // nothing to close.
    if (this.started) await this.started.catch(() => undefined)
    const child = this.child
    if (!child || !this.exit) return { code: null, signal: null, timedOut: false }
    child.stdin?.end()
    const timeoutMs = opts?.timeoutMs ?? 5000
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<TransportExit>((resolve) => {
      timer = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), timeoutMs)
    })
    try {
      return await Promise.race([this.exit, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
