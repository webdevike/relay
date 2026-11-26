import * as path from 'node:path'
import { watchTrees } from '../tree-watch'
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
  const watcher = watchTrees(watchTargets(root), onChange, {
    depth: 4,
    ignored: isIgnoredPath,
    label: 'eva-watch',
  })

  return {
    async close() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
      watcher.close()
    },
  }
}

/**
 * `EVAOS_E2E_EVA_WATCH_DEBOUNCE_MS` (EVAOS_E2E=1 only) stretches the debounce so a spec can
 * change a file under an open view and have it stay stale for as long as the spec needs; the
 * default 250 ms is shorter than a loaded Mac takes between two steps of a spec.
 */
export function startEvaWatch(
  ctx: MainContext,
  opts?: { debounceMs?: number },
): { close(): Promise<void> } {
  const override = Number(process.env.EVAOS_E2E_EVA_WATCH_DEBOUNCE_MS)
  const debounceMs = ctx.env.e2e && override > 0 ? override : opts?.debounceMs
  return startEvaWatchWith(ctx.env.evaRoot, (areas) => emit(ctx, 'eva.changed', { areas }), {
    ...(debounceMs !== undefined ? { debounceMs } : {}),
  })
}
