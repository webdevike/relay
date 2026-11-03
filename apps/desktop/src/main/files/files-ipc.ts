import * as os from 'node:os'
import { shell } from 'electron'
import type { ChatHandles } from '../chat'
import type { MainContext } from '../context'
import { childPathFor } from '../eva/spawn'
import { emit, handle } from '../ipc/handle'
import { findRg } from './files-search'
import { createFilesService } from './files-service'

/** The Files panel: one root folder (the open chat's worktree, else the Eva root) per call. */
export function registerFilesIpc(ctx: MainContext, chat: Pick<ChatHandles, 'placeOf'>): void {
  let childEnv: Promise<NodeJS.ProcessEnv> | null = null
  const env = (): Promise<NodeJS.ProcessEnv> =>
    (childEnv ??= childPathFor(ctx.env.live, os.homedir()).then((PATH) => ({
      ...process.env,
      PATH,
    })))
  let rg: Promise<string | null> | null = null
  const service = createFilesService({
    evaRoot: ctx.env.evaRoot,
    placeOf: (file) => chat.placeOf(file),
    env,
    rgPath: () => (rg ??= env().then((e) => findRg(e.PATH ?? ''))),
    emitChanged: (root, paths) => emit(ctx, 'files.changed', { root, paths }),
  })
  handle(ctx, 'files.root', ({ file }) => service.root(file))
  handle(ctx, 'files.list', ({ root, dir }) => service.list(root, dir))
  handle(ctx, 'files.read', ({ root, path }) => service.read(root, path))
  handle(ctx, 'files.save', (input) => service.save(input))
  handle(ctx, 'files.gitStatus', ({ root }) => service.gitStatus(root))
  handle(ctx, 'files.all', ({ root }) => service.all(root))
  handle(ctx, 'files.search', ({ root, ...q }) => service.search(root, q))
  handle(ctx, 'files.watch', ({ root, paths }) => service.watch(root, paths))
  handle(ctx, 'files.reveal', async ({ root, path }) => {
    shell.showItemInFolder(await service.revealPath(root, path))
    return {}
  })
  ctx.onBeforeQuit(() => service.close())
}
