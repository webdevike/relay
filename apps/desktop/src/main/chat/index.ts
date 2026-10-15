import type { MainContext } from '../context'
import { createSessionManager, registerLiveIpc } from './live-ipc'
import { registerTranscriptIpc } from './transcript-ipc'

export function registerChat(ctx: MainContext): void {
  const manager = createSessionManager(ctx)
  registerTranscriptIpc(ctx, (paneId, file, parsed) =>
    manager.open(paneId, file, parsed.messages, parsed.meta),
  )
  registerLiveIpc(ctx, manager)
  // Quit ends stdin on every omp this app started and waits; it never signals (D-17).
  ctx.onBeforeQuit(() => manager.closeAll())
}
