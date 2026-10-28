import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RelayFrames } from '../relay/client'

/** Bytes fetched of a chat that is neither open nor recent: its header lines, for the list. */
export const HEAD_BYTES = 16 * 1024
/** A chat written this recently is mirrored in full and tailed. */
export const RECENT_MS = 2 * 24 * 60 * 60 * 1000
/** How long `open` and `blob` wait for the host before going on with what is there. */
const WAIT_MS = 20_000
/** Activity frames after which the host's list is asked for again (Q2: no push frame). */
const ACTIVITY: Record<string, true> = {
  'agents.snapshot': true,
  'agents.delta': true,
  'agent.messages': true,
  'agent.message.update': true,
}
const RELIST_MS = 300
const HASH = /^[0-9a-f]{64}$/

/** `<userData>/remote-sessions`: one flat sessions dir and the blobs beside it (`<root>/blobs`). */
export function remoteSessionsDir(configDir: string): string {
  return path.join(configDir, 'remote-sessions', 'sessions')
}

interface Entry {
  dir: string
  name: string
  /** The omp profile store on the host; absent for the default `~/.omp/agent`. */
  profile?: string
  size: number
  mtime: number
  /** Bytes of the host file mirrored so far (a prefix of it). */
  have: number
  full: boolean
  reading: boolean
  waiters: Array<() => void>
}

/**
 * Mirrors the remote Relay Host's omp transcripts into `dir` so the file-based chat stack works
 * unchanged. Every file's head is fetched for the list; recent and opened files in full, then
 * tailed by offset when a re-list shows them grown. Host files share one dir by name
 * (`<stamp>_<id>.jsonl`), whatever their store or project dir.
 */
export class RemoteSessions {
  private readonly entries = new Map<string, Entry>()
  private readonly blobWaiters = new Map<string, Array<() => void>>()
  private readonly blobsDir: string
  private relistTimer: NodeJS.Timeout | undefined
  private off: (() => void) | undefined

  constructor(
    private readonly link: RelayFrames,
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.blobsDir = path.join(path.dirname(dir), 'blobs')
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(this.blobsDir, { recursive: true })
  }

  start(): void {
    this.off = this.link.onFrame((f) => this.receive(f))
    // Already connected (started late): list now; otherwise `welcome` does.
    this.link.sendFrame({ t: 'sessions.list' })
  }

  stop(): void {
    this.off?.()
    clearTimeout(this.relistTimer)
  }

  /** Mirrors `file` in full; resolves once it is (or the host does not answer). */
  open(file: string): Promise<void> {
    const e = this.entries.get(path.basename(file))
    if (!e || (e.full && e.have >= e.size)) return Promise.resolve()
    e.full = true
    return this.wait(e.waiters, () => this.pull(e))
  }

  /** Fetches the image blob `hash` into the mirror's blobs dir when it is not there yet. */
  blob(hash: string): Promise<void> {
    if (!HASH.test(hash) || fs.existsSync(path.join(this.blobsDir, hash))) return Promise.resolve()
    const waiters = this.blobWaiters.get(hash) ?? []
    const first = waiters.length === 0
    this.blobWaiters.set(hash, waiters)
    return this.wait(waiters, () => !first || this.link.sendFrame({ t: 'blob.read', hash }))
  }

  /** Resolves when a waiter is called, after WAIT_MS, or at once when `ask` sent nothing. */
  private wait(waiters: Array<() => void>, ask: () => boolean): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    const done = (): void => {
      clearTimeout(timer)
      const at = waiters.indexOf(done)
      if (at >= 0) waiters.splice(at, 1)
      resolve()
    }
    const timer = setTimeout(done, WAIT_MS)
    waiters.push(done)
    if (!ask()) done()
    return promise
  }

  private receive(f: Record<string, unknown>): void {
    if (f.t === 'welcome') {
      // A new connection: reads in flight on the old one are gone.
      for (const e of this.entries.values()) e.reading = false
      this.link.sendFrame({ t: 'sessions.list' })
    } else if (typeof f.t === 'string' && ACTIVITY[f.t] === true) {
      this.relistTimer ??= setTimeout(() => {
        this.relistTimer = undefined
        this.link.sendFrame({ t: 'sessions.list' })
      }, RELIST_MS)
    } else if (f.t === 'sessions.list' && Array.isArray(f.files)) {
      this.list(f.files as Array<Record<string, unknown>>)
    } else if (f.t === 'session.chunk') {
      this.chunk(f)
    } else if (f.t === 'blob.data' && typeof f.hash === 'string' && HASH.test(f.hash)) {
      if (typeof f.data === 'string') {
        fs.writeFileSync(path.join(this.blobsDir, f.hash), Buffer.from(f.data, 'base64'))
      }
      for (const done of [...(this.blobWaiters.get(f.hash) ?? [])]) done()
      this.blobWaiters.delete(f.hash)
    }
  }

  private list(files: Array<Record<string, unknown>>): void {
    const seen = new Set<string>()
    for (const f of files) {
      const { dir, name, size, mtime, profile } = f
      if (typeof dir !== 'string' || typeof name !== 'string') continue
      if (typeof size !== 'number' || typeof mtime !== 'number') continue
      if (name !== path.basename(name) || !name.endsWith('.jsonl') || seen.has(name)) continue
      seen.add(name)
      let e = this.entries.get(name)
      if (!e) {
        e = { dir, name, size, mtime, have: 0, full: false, reading: false, waiters: [] }
        this.entries.set(name, e)
        // Restarted app: the mirrored prefix stays, read on from its end.
        try {
          e.have = fs.statSync(this.local(e)).size
        } catch {
          // not mirrored yet
        }
      }
      if (typeof profile === 'string') e.profile = profile
      else delete e.profile
      e.dir = dir
      e.size = size
      e.mtime = mtime
      if (this.now() - mtime < RECENT_MS) e.full = true
      this.pull(e)
    }
    for (const [name, e] of this.entries) {
      if (seen.has(name)) continue
      this.entries.delete(name)
      fs.rmSync(this.local(e), { force: true })
    }
  }

  /** Asks for the next bytes `e` lacks; false when nothing is asked. */
  private pull(e: Entry): boolean {
    if (e.reading) return true
    if (e.size < e.have) {
      // Truncated or rewritten on the host: start over.
      fs.rmSync(this.local(e), { force: true })
      e.have = 0
    }
    // A head is a few whole lines; once read it stays as is until the file is opened or recent.
    const want = e.full ? e.size : e.have > 0 ? e.have : Math.min(e.size, HEAD_BYTES)
    if (e.have >= want) {
      if (e.have === 0) fs.closeSync(fs.openSync(this.local(e), 'a'))
      this.touch(e)
      for (const done of [...e.waiters]) done()
      return false
    }
    const ask: Record<string, unknown> = {
      t: 'session.read',
      dir: e.dir,
      name: e.name,
      offset: e.have,
      ...(!e.full && { limit: want - e.have }),
      ...(e.profile !== undefined && { profile: e.profile }),
    }
    e.reading = true
    if (this.link.sendFrame(ask)) return true
    e.reading = false
    return false
  }

  private chunk(f: Record<string, unknown>): void {
    const e = typeof f.name === 'string' ? this.entries.get(f.name) : undefined
    if (!e || f.offset !== e.have || typeof f.size !== 'number') return
    e.reading = false
    if (typeof f.data !== 'string') {
      // Gone on the host since the list; the next list drops it.
      for (const done of [...e.waiters]) done()
      return
    }
    let bytes = Buffer.from(f.data, 'base64')
    if (!e.full) {
      // A head stops at its last full line so the scanner never reads half a record; a first
      // line longer than the head means the whole file.
      const end = bytes.lastIndexOf(0x0a) + 1
      if (end === 0) e.full = true
      else bytes = bytes.subarray(0, end)
    }
    if (bytes.length > 0) fs.appendFileSync(this.local(e), bytes)
    e.have += bytes.length
    e.size = f.size
    this.pull(e)
  }

  /** The host's mtime on the mirror, so the list orders and dates chats as the host has them. */
  private touch(e: Entry): void {
    try {
      fs.utimesSync(this.local(e), new Date(), new Date(e.mtime))
    } catch {
      // the next list writes it
    }
  }

  private local(e: Entry): string {
    return path.join(this.dir, e.name)
  }
}
