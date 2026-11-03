import * as fs from 'node:fs'
import * as path from 'node:path'
import { watch } from 'chokidar'
import { slugOf } from './store'

export interface CanvasWatch {
  close(): Promise<void>
}

/**
 * Watches the boards folder. A board whose text changed from outside Relay sends its slug; a
 * board appearing or disappearing sends null (the list changed). `isOwn` tells Relay's own writes
 * apart so they never echo back.
 */
export function startCanvasWatchWith(
  watchDir: string,
  isOwn: (slug: string, text: string | null) => boolean,
  send: (slug: string | null) => void,
  opts: { debounceMs?: number } = {},
): CanvasWatch {
  const debounceMs = opts.debounceMs ?? 250
  const dir = path.resolve(watchDir)
  const known = new Set<string>()
  try {
    for (const name of fs.readdirSync(dir)) {
      const slug = slugOf(name)
      if (slug) known.add(slug)
    }
  } catch {
    // A missing folder has no boards yet.
  }
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  let closed = false

  const flush = (): void => {
    timer = null
    if (closed) return
    let listChanged = false
    const changed: string[] = []
    for (const slug of pending) {
      let text: string | null
      try {
        text = fs.readFileSync(path.join(dir, `${slug}.json`), 'utf8')
      } catch {
        text = null
      }
      const existed = known.has(slug)
      if (text === null) known.delete(slug)
      else known.add(slug)
      if (isOwn(slug, text)) continue
      if (text === null) {
        if (existed) listChanged = true
      } else if (existed) {
        changed.push(slug)
      } else {
        listChanged = true
      }
    }
    pending.clear()
    if (listChanged) send(null)
    for (const slug of changed) send(slug)
  }

  const watcher = watch(dir, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignored: (p) => p !== dir && path.dirname(p) === dir && slugOf(p) === null,
  })
  const onChange = (p: string): void => {
    if (closed || path.dirname(p) !== dir) return
    const slug = slugOf(p)
    if (!slug) return
    pending.add(slug)
    timer ??= setTimeout(flush, debounceMs)
  }
  watcher.on('add', onChange).on('change', onChange).on('unlink', onChange)
  watcher.on('error', (err) =>
    console.error('[canvas-watch] watcher error:', (err as Error).message),
  )

  return {
    async close() {
      closed = true
      clearTimeout(timer ?? undefined)
      timer = null
      pending.clear()
      await watcher.close()
    },
  }
}
