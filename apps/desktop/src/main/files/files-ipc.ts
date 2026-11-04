import * as os from 'node:os'
import { shell } from 'electron'
import type { ChatHandles } from '../chat'
import type { MainContext } from '../context'
import { childPathFor } from '../eva/spawn'
import { emit, handle } from '../ipc/handle'
import { createHostAgentFiles } from '../relay/host-agent-files'
import { createAgentFiles, isHostRoot, localAgentFiles } from './agent-files'
import { findRg } from './files-search'
import { createFilesService } from './files-service'

/**
 * The Files panel: one root folder (the open chat's worktree, else the Eva root) per call. On a thin
 * client (remote mode) an assistant's instruction files are the Mini's, so their virtual roots are
 * served through the Mini's Relay Host (`agent-files.ts`) and every other root stays on this Mac.
 * `onSave` hears each save before it writes (live presence tells the host the write is Isaac's).
 */
export function registerFilesIpc(
  ctx: MainContext,
  chat: Pick<ChatHandles, 'placeOf' | 'frames'>,
  onSave: (root: string, rel: string, text: string) => void,
): { hostPathOf(root: string, rel: string): string | null } {
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
  const agentFiles = ctx.env.relayRemote
    ? createAgentFiles({
        host: createHostAgentFiles(chat.frames),
        emitChanged: (root, paths) => emit(ctx, 'files.changed', { root, paths }),
      })
    : null
  handle(ctx, 'files.root', ({ file }) => service.root(file))
  handle(ctx, 'files.agent', async ({ agent }) => {
    if (agentFiles) return agentFiles.open(agent)
    const { root, name } = await service.root(null)
    return { root, name, ...localAgentFiles(root, agent), remote: false }
  })
  handle(ctx, 'files.list', ({ root, dir }) =>
    agentFiles && isHostRoot(root) ? agentFiles.list(root, dir) : service.list(root, dir),
  )
  handle(ctx, 'files.read', ({ root, path }) =>
    agentFiles && isHostRoot(root) ? agentFiles.read(root, path) : service.read(root, path),
  )
  handle(ctx, 'files.save', (input) => {
    onSave(input.root, input.path, input.text)
    return agentFiles && isHostRoot(input.root) ? agentFiles.save(input) : service.save(input)
  })
  // A virtual root has no git, no quick-open list and nothing to search.
  handle(ctx, 'files.gitStatus', ({ root }) =>
    agentFiles && isHostRoot(root)
      ? { repo: false, branch: null, changes: {}, ignored: [] }
      : service.gitStatus(root),
  )
  handle(ctx, 'files.all', ({ root }) =>
    agentFiles && isHostRoot(root) ? { files: [], truncated: false } : service.all(root),
  )
  handle(ctx, 'files.search', ({ root, ...q }) =>
    agentFiles && isHostRoot(root)
      ? { results: [], truncated: false, engine: 'scan' as const }
      : service.search(root, q),
  )
  handle(ctx, 'files.watch', ({ root, paths }) => {
    if (agentFiles && isHostRoot(root)) return agentFiles.watch(root, paths)
    // Another root in front: stop checking the Mini's files.
    agentFiles?.watch('', [])
    return service.watch(root, paths)
  })
  handle(ctx, 'files.reveal', async ({ root, path }) => {
    if (isHostRoot(root))
      throw new Error('This file is on the Mini; there is nothing to show in Finder.')
    shell.showItemInFolder(await service.revealPath(root, path))
    return {}
  })
  ctx.onBeforeQuit(() => {
    agentFiles?.close()
    return service.close()
  })
  return { hostPathOf: (root, rel) => agentFiles?.hostPathOf(root, rel) ?? null }
}
