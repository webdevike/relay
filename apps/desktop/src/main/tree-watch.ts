import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Change notifications for folders that grow with Isaac's data (omp sessions, jobs, work items,
 * experiments) without holding a file descriptor per file.
 *
 * chokidar 5 watches every file it sees with its own `fs.watch`, and on macOS each of those is a
 * kqueue descriptor. Over the sessions stores that reached ~11k open files in the main process,
 * and past ~10k descriptors macOS Chromium can no longer start a sandboxed helper ("Failed to
 * initialize sandbox"): the audio service died on launch and every video with sound failed with
 * AUDIO_RENDERER_ERROR. A recursive `fs.watch` on a folder is one FSEvents stream on macOS
 * (inotify per folder on Linux) whatever the folder holds. Use this for any tree that grows;
 * chokidar stays only where the watched set is small and its write-finish handling matters.
 */
export interface TreeWatchOptions {
  /**
   * Folder levels below a root that count, as chokidar's `depth`: 0 is the root's own entries,
   * 1 adds its subfolders' entries. Deeper changes are dropped.
   */
  depth: number
  ignored?: (p: string) => boolean
  /** How often a root that does not exist yet (or went away) is looked for again. */
  retryMs?: number
  /** Names the watcher in error logs. */
  label: string
}

export interface TreeWatch {
  close(): void
}

const RETRY_MS = 2000

/**
 * Calls `onPath` with the absolute path of every change under `roots` (a folder, or a single file
 * watched through its parent so atomic renames over it still count). Events carry no kind: callers
 * re-read what they show. A root that is missing is picked up when it appears.
 */
export function watchTrees(
  roots: readonly string[],
  onPath: (p: string) => void,
  opts: TreeWatchOptions,
): TreeWatch {
  const stops = roots.map((root) => watchRoot(path.resolve(root), onPath, opts))
  return {
    close() {
      for (const stop of stops) stop()
    },
  }
}

function watchRoot(root: string, onPath: (p: string) => void, opts: TreeWatchOptions): () => void {
  let watcher: fs.FSWatcher | null = null
  let retry: NodeJS.Timeout | null = null
  let closed = false

  const emit = (p: string): void => {
    if (!closed && !opts.ignored?.(p)) onPath(p)
  }

  const waitForRoot = (): void => {
    watcher?.close()
    watcher = null
    if (closed || retry) return
    retry = setInterval(() => {
      if (!fs.existsSync(root)) return
      clearInterval(retry!)
      retry = null
      if (start()) emit(root)
    }, opts.retryMs ?? RETRY_MS)
    retry.unref()
  }

  /** Starts the watcher; false when the root is not there (the retry takes over). */
  const start = (): boolean => {
    let st: fs.Stats
    try {
      st = fs.statSync(root)
    } catch {
      waitForRoot()
      return false
    }
    try {
      if (st.isDirectory()) {
        watcher = fs.watch(root, { recursive: opts.depth > 0 }, (event, name) => {
          const rel = name?.toString() ?? ''
          if (rel === '' || rel.split(path.sep).length <= opts.depth + 1)
            emit(rel === '' ? root : path.join(root, rel))
          // The root itself renamed or deleted: wait for it to come back.
          if (event === 'rename' && !fs.existsSync(root)) waitForRoot()
        })
      } else {
        // A file: its parent's listing, so a rename over it (atomic save) still reports.
        const base = path.basename(root)
        watcher = fs.watch(path.dirname(root), (_event, name) => {
          if (name !== null && name.toString() === base) emit(root)
        })
      }
    } catch (e) {
      console.error(`[${opts.label}] can't watch ${root}:`, (e as Error).message)
      waitForRoot()
      return false
    }
    watcher.on('error', (e) => {
      console.error(`[${opts.label}] watcher error:`, e.message)
      waitForRoot()
    })
    return true
  }

  start()
  return () => {
    closed = true
    clearInterval(retry ?? undefined)
    retry = null
    watcher?.close()
    watcher = null
  }
}
