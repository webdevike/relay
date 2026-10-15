import type { MainContext } from '../context'
import { emit } from '../ipc/handle'
import type { WriteQueue } from '../write-queue'
import { ChatListService } from './chat-list'
import { ChatWatch } from './chat-watch'
import { registerChatListIpc } from './chat-list-ipc'
import { createSessionManager, registerLiveIpc } from './live-ipc'
import { registerTranscriptIpc } from './transcript-ipc'

export interface ChatHandles {
  /** Subscribe to debounced batches of changed session paths; do not start a second watcher. */
  onSessionsChanged(cb: (files: string[]) => void): () => void
}

const STATUS_COALESCE_MS = 30

export function registerChat(ctx: MainContext, queue: WriteQueue): ChatHandles {
  const manager = createSessionManager(ctx)
  registerTranscriptIpc(ctx, (paneId, file, parsed) =>
    manager.open(paneId, file, parsed.messages, parsed.meta),
  )
  registerLiveIpc(ctx, manager)
  const list = new ChatListService({
    sessionsDir: ctx.env.sessionsDir,
    agentDir: ctx.env.agentDir,
    config: ctx.config,
    liveFiles: () => manager.liveFiles(),
    liveStatus: (file) => manager.liveStatus(file),
  })
  registerChatListIpc(ctx, queue, list, manager)

  const watch = new ChatWatch({
    dir: ctx.env.sessionsDir,
    isLive: (f) => manager.liveFiles().has(f),
  })
  const emitList = (): void => emit(ctx, 'chat.listChanged', list.list())
  watch.onChange((files) => {
    for (const f of files) list.invalidate(f)
    emitList()
  })
  // The app's own sessions change status without any file change.
  let statusTimer: NodeJS.Timeout | null = null
  const offStatus = manager.onStatusChange(() => {
    if (statusTimer) return
    statusTimer = setTimeout(() => {
      statusTimer = null
      emitList()
    }, STATUS_COALESCE_MS)
  })
  watch.start()

  ctx.onBeforeQuit(async () => {
    offStatus()
    if (statusTimer) clearTimeout(statusTimer)
    await watch.close()
  })
  // Quit ends stdin on every omp this app started and waits; it never signals (D-17).
  ctx.onBeforeQuit(() => manager.closeAll())
  return { onSessionsChanged: (cb) => watch.onChange(cb) }
}
