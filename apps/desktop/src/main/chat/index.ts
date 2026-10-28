import * as os from 'node:os'
import { Notification } from 'electron'
import type { MainContext } from '../context'
import { ChatAlertTracker, type ChatAlert } from './chat-alerts'
import { registerAssistantsIpc } from '../assistants/assistants-ipc'
import { emit } from '../ipc/handle'
import { startRelay } from '../relay'
import { awaySignature } from '../relay/away'
import { registerBoardsIpc } from '../relay/boards-ipc'
import { registerReactionsIpc } from '../relay/reactions-ipc'
import { registerArtifactsIpc } from '../relay/artifacts-ipc'
import { registerCanvasLiveIpc } from '../relay/canvas-live-ipc'
import type { RelayArtifacts, RelayCanvas, RelaySource } from '../relay/client'
import type { WriteQueue } from '../write-queue'
import { AUTO_SETTLE_DAYS } from './chat-order'
import { ChatListService, chatSessionsDirs } from './chat-list'
import { importNativeChatState, nativeConfigDir } from './native-import'
import { ChatWatch } from './chat-watch'
import { ExtrasService } from './extras'
import { registerChatListIpc } from './chat-list-ipc'
import { createSessionManager, registerLiveIpc } from './live-ipc'
import { registerTranscriptIpc, resolveInsideSessionsDir } from './transcript-ipc'
import type { Place } from '@evaos/chat-core/work'
import type { Assistants } from '@evaos/contract'
import type { RelaySession } from '../relay/feed'

export interface ChatHandles {
  /** Subscribe to debounced batches of changed session paths; do not start a second watcher. */
  onSessionsChanged(cb: (files: string[]) => void): () => void
  /**
   * Where a chat session works (folder, active worktree). Throws `outside-sessions-dir` for a
   * file that is not a session the list spans; null when it cannot be read.
   */
  placeOf(file: string): Place | null
  /** A chat this app runs is mid-reply (a pending update's auto-restart waits for it). */
  anyWorking(): boolean
  /** The registry's assistants with their threads, as `assistants.list` gives them. */
  assistants(): Assistants
  /** Relay's sessions by id while connected, else null. */
  relaySessions(): ReadonlyMap<string, RelaySession> | null
  /** Relay's artifacts of every thread (the panel, the status reader, agent actions). */
  artifacts: RelaySource & RelayArtifacts
  /** Relay's live canvas rooms and the host's origin (canvas.live). */
  canvas: RelayCanvas
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
  const alerts = new ChatAlertTracker()
  // Held until closed or clicked: a collected Notification loses its click handler on macOS.
  const shown = new Set<Notification>()
  const notify = (a: ChatAlert): void => {
    const n = new Notification({ title: a.title, body: a.body, silent: a.kind === 'finished' })
    shown.add(n)
    n.on('click', () => {
      shown.delete(n)
      if (ctx.win.isMinimized()) ctx.win.restore()
      ctx.win.show()
      ctx.win.focus()
      emit(ctx, 'chat.openRequested', { file: a.file })
    })
    n.on('close', () => shown.delete(n))
    n.show()
  }
  const emitList = (): void => {
    const l = list.list()
    emit(ctx, 'chat.listChanged', l)
    const due = alerts.update(l)
    // Fixture sessions (dev, e2e) never notify; a focused window already shows the change.
    if (!ctx.env.live || ctx.win.isFocused() || !Notification.isSupported()) return
    for (const a of due) notify(a)
  }
  registerChatListIpc(ctx, queue, list, manager, sessionsDirs, emitList)
  // Assistant threads: Relay says how each stands, their files hold the last reply.
  const assistants = registerAssistantsIpc(ctx, relay, sessionsDirs)
  // The host's dashboards, as Relay streams them.
  const offBoards = registerBoardsIpc(ctx, relay)
  // Tapbacks on the bubbles of the chats shown, as Relay keeps them for every device.
  const offReactions = registerReactionsIpc(ctx, relay)
  // What each thread holds (tickets, PRs, media, subagents), for the Artifacts panel.
  const offArtifacts = registerArtifactsIpc(ctx, relay)
  // Live canvas rooms on the host, and the way into one (the Canvas page's frame).
  const offCanvasLive = registerCanvasLiveIpc(ctx, relay)

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
    assistants.refresh()
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
    offBoards()
    offReactions()
    offArtifacts()
    offCanvasLive()
    clearTimeout(statusTimer)
    assistants.close()
    await watch.close()
  })
  // Quit ends stdin on every omp this app started and waits; it never signals (D-17).
  ctx.onBeforeQuit(() => manager.closeAll())
  return {
    onSessionsChanged: (cb) => watch.onChange(cb),
    placeOf: (file) => list.placeOf(resolveInsideSessionsDir(sessionsDirs, file)),
    anyWorking: () => manager.anyWorking(),
    assistants: () => assistants.list(),
    relaySessions: () => relay.sessions(),
    artifacts: relay,
    canvas: relay,
  }
}
