import * as path from 'node:path'
import { watch } from 'chokidar'
import type { MainContext } from '../context'
import { emit } from '../ipc/handle'

export type EvaArea = 'workspaces' | 'memory' | 'jobs' | 'meetings'

/** Narrow explicit targets only; never the whole checkout. */
export function watchTargets(root: string): string[] {
  return [
    path.join(root, 'workspaces'),
    path.join(root, 'memory/journal.md'),
    path.join(root, 'memory/archive'),
    path.join(root, 'memory/todos.md'),
    path.join(root, 'memory/todos-done.md'),
    path.join(root, 'jobs'),
    path.join(root, 'work/meetings'),
  ]
}

/** Dependency/VCS folders and the atomic-write temp files (`.<name>.<pid>.tmp`) never count as changes. */
export function isIgnoredPath(p: string): boolean {
  return /(^|\/)(node_modules|\.git)(\/|$)/.test(p) || /(^|\/)\.[^/]*\.tmp$/.test(p)
}

export function areaFor(root: string, changedPath: string): EvaArea | null {
  const rel = path.relative(root, changedPath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  const top = rel.split(path.sep)
  if (top[0] === 'workspaces') return 'workspaces'
  if (top[0] === 'memory') return 'memory'
  if (top[0] === 'jobs') return 'jobs'
  if (top[0] === 'work' && top[1] === 'meetings') return 'meetings'
  return null
}

export function startEvaWatchWith(
  root: string,
  send: (areas: EvaArea[]) => void,
  opts: { debounceMs?: number } = {},
): { close(): Promise<void> } {
  const debounceMs = opts.debounceMs ?? 250
  const pending = new Set<EvaArea>()
  let timer: NodeJS.Timeout | null = null
  let closed = false

  const watcher = watch(watchTargets(root), {
    ignoreInitial: true,
    depth: 4,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignored: isIgnoredPath,
  })
  const onChange = (p: string): void => {
    if (closed) return
    const area = areaFor(root, p)
    if (!area) return
    pending.add(area)
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (closed || pending.size === 0) return
      const areas = [...pending]
      pending.clear()
      send(areas)
    }, debounceMs)
  }
  watcher.on('add', onChange).on('change', onChange).on('unlink', onChange)
  watcher.on('addDir', onChange).on('unlinkDir', onChange)
  watcher.on('error', (err) => console.error('[eva-watch] watcher error:', (err as Error).message))

  return {
    async close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
      await watcher.close()
    },
  }
}

export function startEvaWatch(
  ctx: MainContext,
  opts?: { debounceMs?: number },
): { close(): Promise<void> } {
  return startEvaWatchWith(ctx.env.evaRoot, (areas) => emit(ctx, 'eva.changed', { areas }), opts)
}
