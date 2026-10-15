import * as fs from 'node:fs'
import * as path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { RECENTLY_ACTIVE_MS } from '@evaos/chat-core/chat-groups'

export interface ChatWatchOptions {
  dir: string
  debounceMs?: number
  /** Stat poll period for recently active or live files. */
  pollMs?: number
  /** A file written within this window is polled. */
  recentMs?: number
  /** Whole-directory stat sweep period (belt for old files; fs events are the first line). */
  sweepMs?: number
  isLive?: (file: string) => boolean
  now?: () => number
}

interface Stamp {
  mtimeMs: number
  size: number
}

const SUBAGENT_EXT = /\.(jsonl|md)$/

/**
 * Which path a raw fs event stands for: a top-level session `.jsonl`, or the subagent folder
 * when a `.jsonl`/`.md` changes one level down. Everything else is not a chat change.
 */
export function classify(dir: string, p: string): string | null {
  const rel = path.relative(dir, p)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const parts = rel.split(path.sep)
  if (parts.length === 1) return parts[0]!.endsWith('.jsonl') ? p : null
  if (parts.length === 2 && SUBAGENT_EXT.test(parts[1]!)) return path.join(dir, parts[0]!)
  return null
}

/**
 * Debounced batches of changed session paths. FSEvents can miss appends to a file its writer holds
 * open (the reason the Rust app polls), so chokidar is backed by a fast stat poll of recent or live
 * files and a slower sweep of the rest. Poll cost stays flat: only recent files are stat'd fast.
 */
export class ChatWatch {
  private readonly debounceMs: number
  private readonly pollMs: number
  private readonly recentMs: number
  private readonly sweepMs: number
  private readonly now: () => number
  private readonly cbs = new Set<(files: string[]) => void>()
  private readonly pending = new Set<string>()
  private readonly stamps = new Map<string, Stamp>()
  private watcher: FSWatcher | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private sweepTimer: NodeJS.Timeout | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly o: ChatWatchOptions) {
    this.debounceMs = o.debounceMs ?? 100
    this.pollMs = o.pollMs ?? 200
    this.recentMs = o.recentMs ?? RECENTLY_ACTIVE_MS
    this.sweepMs = o.sweepMs ?? 1000
    this.now = o.now ?? Date.now
  }

  onChange(cb: (files: string[]) => void): () => void {
    this.cbs.add(cb)
    return () => {
      this.cbs.delete(cb)
    }
  }

  start(): void {
    if (this.watcher || this.closed) return
    this.snapshot()
    const watcher = watch(this.o.dir, {
      ignoreInitial: true,
      depth: 1,
      awaitWriteFinish: false,
      followSymlinks: false,
    })
    const hit = (p: string): void => {
      const target = classify(this.o.dir, p)
      if (target !== null) this.mark(target)
    }
    watcher.on('add', hit).on('change', hit).on('unlink', hit)
    watcher.on('addDir', hit).on('unlinkDir', hit)
    watcher.on('error', (e) => console.error('[chat-watch] watcher error:', (e as Error).message))
    this.watcher = watcher
    this.pollTimer = setInterval(() => this.poll(false), this.pollMs)
    this.sweepTimer = setInterval(() => this.poll(true), this.sweepMs)
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.pollTimer = this.sweepTimer = this.flushTimer = null
    this.pending.clear()
    this.cbs.clear()
    const w = this.watcher
    this.watcher = null
    await w?.close()
  }

  private mark(file: string): void {
    if (this.closed) return
    this.pending.add(file)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.closed || this.pending.size === 0) return
      const files = [...this.pending]
      this.pending.clear()
      for (const cb of [...this.cbs]) {
        try {
          cb(files)
        } catch (e) {
          console.error('[chat-watch] listener failed:', (e as Error).message)
        }
      }
    }, this.debounceMs)
  }

  private names(): string[] {
    try {
      return fs.readdirSync(this.o.dir).filter((n) => n.endsWith('.jsonl'))
    } catch {
      return []
    }
  }

  private snapshot(): void {
    for (const n of this.names()) {
      const f = path.join(this.o.dir, n)
      const st = this.statOf(f)
      if (st) this.stamps.set(f, st)
    }
  }

  private statOf(f: string): Stamp | null {
    try {
      const st = fs.lstatSync(f)
      return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null
    } catch {
      return null
    }
  }

  /** `all` sweeps every file and detects adds and removals; otherwise only recent or live files. */
  private poll(all: boolean): void {
    if (this.closed) return
    const t = this.now()
    const check = (f: string): void => {
      const st = this.statOf(f)
      const prev = this.stamps.get(f)
      if (!st) {
        if (prev) {
          this.stamps.delete(f)
          this.mark(f)
        }
        return
      }
      this.stamps.set(f, st)
      if (!prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size) this.mark(f)
    }
    if (all) {
      const present = new Set<string>()
      for (const n of this.names()) {
        const f = path.join(this.o.dir, n)
        present.add(f)
        check(f)
      }
      for (const f of [...this.stamps.keys()]) if (!present.has(f)) check(f)
      return
    }
    for (const [f, st] of [...this.stamps]) {
      if (t - st.mtimeMs < this.recentMs || this.o.isLive?.(f)) check(f)
    }
  }
}
