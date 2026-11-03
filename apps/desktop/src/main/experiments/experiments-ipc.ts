import * as path from 'node:path'
import { watch } from 'chokidar'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { createExperimentsService, type ExperimentsService } from './experiments-service'

/** Files the viewer reads, relative to one experiment folder. */
const WATCHED: Record<string, true> = {
  'summary.json': true,
  'status.json': true,
  'record.md': true,
  'results.md': true,
}

/**
 * The experiment a changed path belongs to, when it is a file the viewer reads (or the folder
 * itself appearing or going); null for run lines, audits and everything else.
 */
export function experimentOf(root: string, changed: string): string | null {
  const parts = path.relative(root, changed).split(path.sep)
  if (!parts[0] || parts[0].startsWith('..') || path.isAbsolute(parts[0])) return null
  if (parts.length === 1) return parts[0]
  if (parts.length === 2 && WATCHED[parts[1]!]) return parts[0]
  if (parts.length === 3 && parts[1] === 'rounds' && parts[2]!.endsWith('.md')) return parts[0]
  return null
}

/** Watches `root` and sends the experiments that changed, debounced; never writes. */
export function startExperimentsWatch(
  root: string,
  send: (ids: string[]) => void,
  debounceMs = 250,
): { close(): Promise<void> } {
  const pending = new Set<string>()
  let timer: NodeJS.Timeout | null = null
  let closed = false
  const watcher = watch(root, {
    ignoreInitial: true,
    depth: 2,
    // status.json is renamed into place after every logged run; no write to wait out.
    awaitWriteFinish: false,
    // Run lines and audits change on every test; status.json already reports that progress.
    ignored: (p) => {
      const parts = path.relative(root, p).split(path.sep)
      return parts[1] === 'runs' || parts[1] === 'audits' || parts.some((s) => s === '.git')
    },
  })
  const onChange = (p: string): void => {
    const id = closed ? null : experimentOf(root, p)
    if (!id) return
    pending.add(id)
    timer ??= setTimeout(() => {
      timer = null
      if (closed || pending.size === 0) return
      const ids = [...pending]
      pending.clear()
      send(ids)
    }, debounceMs)
  }
  watcher
    .on('add', onChange)
    .on('change', onChange)
    .on('unlink', onChange)
    .on('addDir', onChange)
    .on('unlinkDir', onChange)
    .on('error', (e) => console.error('[experiments-watch]', e instanceof Error ? e.message : e))
  return {
    async close() {
      closed = true
      clearTimeout(timer ?? undefined)
      pending.clear()
      await watcher.close()
    },
  }
}

/** Read-only view of `$EVA/work/experiments` for the Test Bench page; the service for other readers. */
export function registerExperimentsIpc(ctx: MainContext): ExperimentsService {
  const root = path.join(ctx.env.evaRoot, 'work', 'experiments')
  const service = createExperimentsService(root)
  handle(ctx, 'experiments.list', () => service.list())
  handle(ctx, 'experiments.get', ({ id }) => service.get(id))
  handle(ctx, 'experiments.cases', ({ id, arm }) => service.cases(id, arm))
  const watcher = startExperimentsWatch(root, (ids) => emit(ctx, 'experiments.changed', { ids }))
  ctx.onBeforeQuit(() => watcher.close())
  return service
}
