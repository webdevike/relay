import type { MainContext } from '../context'
import type { WriteQueue } from '../write-queue'
import { ChatListService } from './chat-list'
import { registerChatListIpc } from './chat-list-ipc'
import { createSessionManager, registerLiveIpc } from './live-ipc'
import { registerTranscriptIpc } from './transcript-ipc'

export function registerChat(ctx: MainContext, queue: WriteQueue): void {
  const manager = createSessionManager(ctx)
  registerTranscriptIpc(ctx, (paneId, file, parsed) =>
    manager.open(paneId, file, parsed.messages, parsed.meta),
  )
  registerLiveIpc(ctx, manager)
  // Live status (which files this app owns) is wired by the live status plan; scan by mtime until then.
  const list = new ChatListService({
    sessionsDir: ctx.env.sessionsDir,
    agentDir: ctx.env.agentDir,
    config: ctx.config,
    liveFiles: () => new Set(),
  })
  registerChatListIpc(ctx, queue, list)
  // Quit ends stdin on every omp this app started and waits; it never signals (D-17).
  ctx.onBeforeQuit(() => manager.closeAll())
}
