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

/** A subagent transcript on the host, mirrored at `<dir>/<parent>/<name>` and tailed while it is watched. */
interface Sub {
  dir: string
  profile?: string
  /** The folders below the sessions dir that hold it, "/"-joined. */
  parent: string
  name: string
  size: number
  have: number
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
  private readonly subs = new Map<string, Sub>()
  /** Called when a mirrored subagent transcript gained bytes (the chat's extras re-read their folder). */
  onSubagentChange: (() => void) | undefined
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

  /**
   * Mirrors the subagent transcript `file` and resolves its local path (null when the host has none).
   * `file` is a host path (`.../sessions/<dir>/<session stem>/<name>.jsonl`, as the Artifacts tab
   * has it) or already a path in the mirror (as the chat's subagent chips have it).
   */
  async openSubagent(file: string): Promise<string | null> {
    const at = this.locate(file)
    if (!at) return null
    const key = `${at.parent}/${at.name}`
    let s = this.subs.get(key)
    if (!s) {
      s = { ...at, size: 0, have: 0, reading: false, waiters: [] }
      this.subs.set(key, s)
      try {
        s.have = fs.statSync(this.subLocal(s)).size
      } catch {
        // not mirrored yet
      }
    }
    const sub = s
    await this.wait(sub.waiters, () => this.pullSub(sub))
    return fs.existsSync(this.subLocal(sub)) ? this.subLocal(sub) : null
  }

  private locate(file: string): Omit<Sub, 'size' | 'have' | 'reading' | 'waiters'> | null {
    const own = path.relative(this.dir, file)
    if (!own.startsWith('..') && !path.isAbsolute(own)) {
      const parts = own.split(path.sep)
      const top = this.entries.get(`${parts[0]}.jsonl`)
      if (!top || parts.length < 2) return null
      return {
        dir: top.dir,
        ...(top.profile !== undefined && { profile: top.profile }),
        parent: parts.slice(0, -1).join('/'),
        name: parts[parts.length - 1]!,
      }
    }
    const m =
      /\/(?:profiles\/([^/]+)\/)?agent\/sessions\/(.+)$/.exec(file) ??
      /\/sessions\/(.+)$/.exec(file)
    const tail = m?.[m.length - 1]
    if (!tail) return null
    const parts = tail.split('/')
    // <dir>/<session stem>[/<subagent stem>...]/<name>.jsonl
    if (parts.length < 3 || !parts[parts.length - 1]!.endsWith('.jsonl')) return null
    const profile = m && m.length === 3 ? m[1] : undefined
    return {
      dir: parts[0]!,
      ...(profile !== undefined && { profile }),
      parent: parts.slice(1, -1).join('/'),
      name: parts[parts.length - 1]!,
    }
  }

  private subLocal(s: Sub): string {
    return path.join(this.dir, ...s.parent.split('/'), s.name)
  }

  /** Asks for the bytes `s` lacks; false when nothing is asked. */
  private pullSub(s: Sub): boolean {
    if (s.reading) return true
    s.reading = true
    const sent = this.link.sendFrame({
      t: 'session.read',
      dir: s.dir,
      parent: s.parent,
      name: s.name,
      offset: s.have,
      ...(s.profile !== undefined && { profile: s.profile }),
    })
    if (!sent) s.reading = false
    return sent
  }

  private subChunk(f: Record<string, unknown>): void {
    const name = typeof f.name === 'string' ? f.name : ''
    const s =
      typeof f.parent === 'string'
        ? this.subs.get(`${f.parent}/${name}`)
        : // A host older than subagent reads answers without `parent`: it has no such file.
          [...this.subs.values()].find((x) => x.reading && x.name === name && x.dir === f.dir)
    if (!s) return
    if (f.parent === undefined || typeof f.data !== 'string' || typeof f.size !== 'number') {
      s.reading = false
      for (const done of [...s.waiters]) done()
      return
    }
    if (f.offset !== s.have) return
    s.reading = false
    const bytes = Buffer.from(f.data, 'base64')
    if (bytes.length > 0 || !fs.existsSync(this.subLocal(s))) {
      fs.mkdirSync(path.dirname(this.subLocal(s)), { recursive: true })
      fs.appendFileSync(this.subLocal(s), bytes)
    }
    s.have += bytes.length
    s.size = f.size
    if (bytes.length > 0) this.onSubagentChange?.()
    if (s.have < s.size && bytes.length > 0) this.pullSub(s)
    else for (const done of [...s.waiters]) done()
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
      for (const s of this.subs.values()) s.reading = false
      this.link.sendFrame({ t: 'sessions.list' })
    } else if (typeof f.t === 'string' && ACTIVITY[f.t] === true) {
      this.relistTimer ??= setTimeout(() => {
        this.relistTimer = undefined
        this.link.sendFrame({ t: 'sessions.list' })
      }, RELIST_MS)
    } else if (f.t === 'sessions.list' && Array.isArray(f.files)) {
      this.list(f.files as Array<Record<string, unknown>>)
    } else if (f.t === 'session.chunk') {
      // A host older than subagent reads answers a subagent read without `parent`.
      const sub =
        f.parent !== undefined ||
        [...this.subs.values()].some((s) => s.reading && s.name === f.name)
      if (sub) this.subChunk(f)
      else this.chunk(f)
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
      const folder = name.replace(/\.jsonl$/, '')
      fs.rmSync(path.join(this.dir, folder), { recursive: true, force: true })
      for (const [key, s] of this.subs) if (s.parent.split('/')[0] === folder) this.subs.delete(key)
    }
    // Watched subagent transcripts grow with their chat: ask for what they gained.
    for (const s of this.subs.values()) this.pullSub(s)
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
