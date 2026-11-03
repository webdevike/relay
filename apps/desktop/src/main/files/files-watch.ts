import * as path from 'node:path'
import { watch, type FSWatcher } from 'chokidar'
import { SAVE_TEMP_RE } from './files-fs'

export const FILES_WATCH_DEBOUNCE_MS = 150

/** One watched path: its root-relative form (what the renderer asked for) and its real path. */
export interface WatchTarget {
  rel: string
  real: string
}

export interface FilesWatch {
  /** Replaces the watched set of `root`; an empty set drops the root's watcher. */
  set(root: string, targets: readonly WatchTarget[]): void
  close(): Promise<void>
}

interface RootWatch {
  watcher: FSWatcher
  /** Real path to the root-relative path it was asked as. */
  byReal: Map<string, string>
  pending: Set<string>
  timer: NodeJS.Timeout | null
}

const ignored = (p: string): boolean => {
  const base = path.basename(p)
  return base === '.git' || p.includes(`${path.sep}.git${path.sep}`) || SAVE_TEMP_RE.test(base)
}

/**
 * One chokidar watcher per root: folders at depth 0 (their listing), files directly (their
 * content). Changes are debounced into one `send(root, paths)`: the watched path that changed,
 * and for an entry inside a watched folder, the folder and the entry itself.
 */
export function createFilesWatch(
  send: (root: string, paths: string[]) => void,
  opts: { debounceMs?: number } = {},
): FilesWatch {
  const debounceMs = opts.debounceMs ?? FILES_WATCH_DEBOUNCE_MS
  const roots = new Map<string, RootWatch>()
  let closed = false

  const drop = (root: string): void => {
    const w = roots.get(root)
    if (!w) return
    roots.delete(root)
    clearTimeout(w.timer ?? undefined)
    void w.watcher.close()
  }

  const start = (root: string, byReal: Map<string, string>): void => {
    const watcher = watch([...byReal.keys()], { ignoreInitial: true, depth: 0, ignored })
    const w: RootWatch = { watcher, byReal, pending: new Set(), timer: null }
    const flush = (): void => {
      w.timer = null
      if (closed || roots.get(root) !== w || w.pending.size === 0) return
      const paths = [...w.pending]
      w.pending.clear()
      send(root, paths)
    }
    watcher.on('all', (_event, p) => {
      if (closed || roots.get(root) !== w) return
      const self = w.byReal.get(p)
      if (self !== undefined) w.pending.add(self)
      const parent = w.byReal.get(path.dirname(p))
      if (parent !== undefined) {
        w.pending.add(parent)
        w.pending.add(parent === '' ? path.basename(p) : `${parent}/${path.basename(p)}`)
      }
      if (w.pending.size > 0) w.timer ??= setTimeout(flush, debounceMs)
    })
    watcher.on('error', (err) =>
      console.error('[files-watch] watcher error:', err instanceof Error ? err.message : err),
    )
    roots.set(root, w)
  }

  return {
    set(root, targets) {
      if (closed) return
      if (targets.length === 0) return drop(root)
      const next = new Map(targets.map((t) => [t.real, t.rel]))
      const w = roots.get(root)
      if (!w) return start(root, next)
      // chokidar's unwatch keeps ignoring a path even under a still-watched folder, so a
      // shrinking set gets a fresh watcher; a growing one adds to the current one.
      if ([...w.byReal.keys()].some((real) => !next.has(real))) {
        drop(root)
        return start(root, next)
      }
      const added = [...next.keys()].filter((real) => !w.byReal.has(real))
      w.byReal = next
      if (added.length > 0) w.watcher.add(added)
    },
    async close() {
      closed = true
      const all = [...roots.values()]
      roots.clear()
      for (const w of all) clearTimeout(w.timer ?? undefined)
      await Promise.all(all.map((w) => w.watcher.close()))
    },
  }
}
