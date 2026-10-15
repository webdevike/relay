import { handle, emit } from '../ipc/handle'
import type { MainContext } from '../context'
import { registerTestHook } from '../test-hooks'
import { OmpStdioTransport } from './omp-transport'
import { SessionManager } from './session-manager'
import { machineLabel } from '@evaos/chat-core/tagged'
import type { Batch } from '@evaos/contract'

export function createSessionManager(ctx: MainContext): SessionManager {
  const dropNext = new Set<string>()
  let extraEnv: Record<string, string> = {}
  const manager: SessionManager = new SessionManager({
    cwd: ctx.env.evaRoot,
    machineLabel: machineLabel(),
    createTransport: () =>
      new OmpStdioTransport({
        ompBin: ctx.env.ompBin,
        live: ctx.env.live,
        takeExtraEnv: () => {
          const e = extraEnv
          extraEnv = {}
          return e
        },
      }),
    emit: (batch: Batch) => {
      // Test hook: the batch consumed a seq but never reaches the renderer (gap recovery e2e).
      if (dropNext.delete(batch.paneId)) return
      emit(ctx, 'chat.batch', batch)
    },
  })
  if (ctx.env.e2e) {
    registerTestHook('chat', {
      dropNextBatch: (paneId: string) => {
        dropNext.add(paneId)
      },
      setFakeEnv: (env: Record<string, string>) => {
        extraEnv = { ...env }
      },
      stats: (paneId: string) => {
        const t = manager.transportOf(paneId) as OmpStdioTransport | null
        return {
          ...manager.stats(paneId),
          spawnArgs: t?.spawnArgs ?? [],
          pid: t?.pid ?? null,
          cwd: t?.spawnCwd ?? '',
        }
      },
    })
  }
  return manager
}

export function registerLiveIpc(ctx: MainContext, manager: SessionManager): void {
  handle(ctx, 'chat.send', async ({ paneId, text }) => {
    await manager.send(paneId, text)
    return { accepted: true as const }
  })
  handle(ctx, 'chat.abort', async ({ paneId }) => ({ sent: await manager.abort(paneId) }))
  handle(ctx, 'chat.close', async ({ paneId }) => ({ exit: await manager.close(paneId) }))
  handle(ctx, 'chat.snapshot', ({ paneId }) => manager.snapshot(paneId))
}
