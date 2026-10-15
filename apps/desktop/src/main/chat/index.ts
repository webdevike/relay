import type { MainContext } from '../context'
import { createSessionManager, registerLiveIpc } from './live-ipc'
import { registerTranscriptIpc } from './transcript-ipc'

export function registerChat(ctx: MainContext): void {
  const manager = createSessionManager(ctx)
  registerTranscriptIpc(ctx, (paneId, file, parsed) =>
    manager.open(paneId, file, parsed.messages, parsed.meta),
  )
  registerLiveIpc(ctx, manager)
}
