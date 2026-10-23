import * as os from 'node:os'
import type { MainContext } from '../context'
import { emit } from '../ipc/handle'
import { startRelay } from '../relay'
import { awaySignature } from '../relay/away'
import type { WriteQueue } from '../write-queue'
import { AUTO_SETTLE_DAYS } from './chat-order'
import { ChatListService, chatSessionsDirs } from './chat-list'
import { importNativeChatState, nativeConfigDir } from './native-import'
import { ChatWatch } from './chat-watch'
import { ExtrasService } from './extras'
import { registerChatListIpc } from './chat-list-ipc'
import { createSessionManager, registerLiveIpc } from './live-ipc'
import { registerTranscriptIpc } from './transcript-ipc'

export interface ChatHandles {
  /** Subscribe to debounced batches of changed session paths; do not start a second watcher. */
  onSessionsChanged(cb: (files: string[]) => void): () => void
}

const STATUS_COALESCE_MS = 30

export function registerChat(ctx: MainContext, queue: WriteQueue): ChatHandles {
  // Before the manager: a chat omp runs elsewhere is driven through Relay.
  const relay = startRelay(ctx)
  const manager = createSessionManager(ctx, relay)
  // Resolved once at launch: every omp store's sessions dir for the Eva root (fixture dir when not live).
  const sessionsDirs = chatSessionsDirs(ctx.env)
  const extras = new ExtrasService({ manager, emit: (e) => emit(ctx, 'chat.extras', e) })
  registerTranscriptIpc(
    ctx,
    sessionsDirs,
    (paneId, file, parsed) => {
      manager.open(paneId, file, parsed.messages, parsed.meta, parsed.named)
      // The event reaches the renderer before this invoke resolves; the store carries it over.
      extras.reset(paneId)
      extras.refresh(paneId)
    },
    (file) => manager.ownerOf(file),
  )
  registerLiveIpc(ctx, manager)
  // Before the list loads its order: a fresh live config starts from the native app's history.
  if (ctx.env.live) importNativeChatState(ctx.config, nativeConfigDir())
  const list = new ChatListService({
    sessionsDirs,
    agentDir: ctx.env.agentDir,
    evaRoot: ctx.env.evaRoot,
    config: ctx.config,
    // Fixture sessions are days old; auto-settle would move them all under Settled in dev and e2e.
    autoSettleDays: ctx.env.live ? AUTO_SETTLE_DAYS : null,
    home: os.homedir(),
    liveFiles: () => manager.liveFiles(),
    liveStatus: (file) => manager.liveStatus(file),
    relay: () => relay.sessions(),
  })
  const emitList = (): void => emit(ctx, 'chat.listChanged', list.list())
  registerChatListIpc(ctx, queue, list, manager, sessionsDirs, emitList)

  const watch = new ChatWatch({
    dirs: sessionsDirs,
    isLive: (f) => manager.liveFiles().has(f),
  })
  watch.onChange((files) => {
    for (const f of files) list.invalidate(f)
    // An outside chat shows its file as omp writes it.
    manager.filesChanged(files)
    emitList()
    extras.onFilesChanged(files)
  })
  // The app's own sessions and Relay's change status without any file change.
  let statusTimer: NodeJS.Timeout | undefined
  const scheduleList = (): void => {
    if (statusTimer) return
    statusTimer = setTimeout(() => {
      statusTimer = undefined
      emitList()
    }, STATUS_COALESCE_MS)
  }
  const offStatus = manager.onStatusChange(() => {
    extras.refresh()
    scheduleList()
  })
  // Relay sends a delta on every bit of activity; only a change the list shows pushes a new one.
  let relaySeen = awaySignature(relay.sessions())
  const offRelay = relay.onChange(() => {
    const next = awaySignature(relay.sessions())
    if (next === relaySeen) return
    relaySeen = next
    scheduleList()
  })
  watch.start()

  ctx.onBeforeQuit(async () => {
    offStatus()
    offRelay()
    clearTimeout(statusTimer)
    await watch.close()
  })
  // Quit ends stdin on every omp this app started and waits; it never signals (D-17).
  ctx.onBeforeQuit(() => manager.closeAll())
  return { onSessionsChanged: (cb) => watch.onChange(cb) }
}
