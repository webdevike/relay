import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { sessionId } from '@evaos/chat-core/session-id'
import type { MainContext } from '../context'
import { ChatAlertTracker } from './chat-alerts'
import { registerNotifications, type Notifier } from '../notifications'
import { registerAssistantsIpc } from '../assistants/assistants-ipc'
import { emit } from '../ipc/handle'
import { startRelay } from '../relay'
import { awaySignature } from '../relay/away'
import { registerBoardsIpc } from '../relay/boards-ipc'
import { registerReactionsIpc } from '../relay/reactions-ipc'
import { registerAsksIpc } from '../relay/asks-ipc'
import { registerArtifactsIpc } from '../relay/artifacts-ipc'
import { registerActivityIpc } from '../relay/activity-ipc'
import { registerCanvasLiveIpc } from '../relay/canvas-live-ipc'
import { registerSkillsIpc } from '../relay/skills-ipc'
import { registerStudioIpc } from '../relay/studio-ipc'
import { registerStatsIpc } from '../relay/stats-ipc'
import type {
  RelayArtifacts,
  RelayCanvas,
  RelayFeatures,
  RelayFrames,
  RelaySource,
  RelayStudio,
} from '../relay/client'
import { createMini, type Mini } from '../relay/mini'
import type { WriteQueue } from '../write-queue'
import { AUTO_SETTLE_DAYS } from './chat-order'
import { ChatListService, chatSessionsDirs } from './chat-list'
import { RemoteSessions } from './remote-sessions'
import { importNativeChatState, nativeConfigDir } from './native-import'
import { ChatWatch } from './chat-watch'
import { ExtrasService } from './extras'
import { registerChatListIpc } from './chat-list-ipc'
import { createSessionManager, registerLiveIpc } from './live-ipc'
import { SessionOwners } from './owners'
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
  /** The session file of omp session `id` in the list's dirs, or null when none is there. */
  sessionFile(id: string): string | null
  /** Relay's artifacts of every thread (the panel, the status reader, agent actions). */
  artifacts: RelaySource & RelayArtifacts
  /** Relay's live canvas rooms and the host's origin (canvas.live). */
  canvas: RelayCanvas
  /** Studio on the host (the Studio page, studio.* agent actions). */
  studio: RelaySource & RelayStudio & Pick<RelayCanvas, 'canvasOrigin'>
  /** The Mini's omp in remote mode (`relayRemote`), else null. */
  mini: Mini | null
  /** Raw frames of the Relay connection (the remote host's `reviews.req` answers) and its features. */
  frames: RelayFrames & RelayFeatures
  /** The connected Relay Host's name and version, null while not connected. */
  hostInfo(): { name: string; version: string } | null
  /** Desktop notifications: the update flow tells it about a build that is ready. */
  notifier: Notifier
}

const STATUS_COALESCE_MS = 30

export function registerChat(ctx: MainContext, queue: WriteQueue): ChatHandles {
  // Before the manager: a chat omp runs elsewhere is driven through Relay.
  const relay = startRelay(ctx)
  // Remote mode: omp runs only on the Mini, asked through Relay.
  const mini = ctx.env.relayRemote ? createMini(relay, () => relay.sessions()) : null
  const manager = createSessionManager(ctx, relay, mini)
  // Resolved once at launch: every omp store's sessions dir for the Eva root (fixture dir when not
  // live), or the mirror of a remote host's sessions.
  const sessionsDirs = chatSessionsDirs(ctx.env)
  // A remote host's chats are mirrored as files (re-listed and tailed on every connection).
  const remote = ctx.env.relayRemote ? new RemoteSessions(relay, sessionsDirs[0] as string) : null
  remote?.start()
  ctx.onBeforeQuit(async () => remote?.stop())
  const extras = new ExtrasService({ manager, emit: (e) => emit(ctx, 'chat.extras', e) })
  if (remote) remote.onSubagentChange = () => extras.refresh()
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
    remote,
    new SessionOwners(ctx.env.evaRoot),
  )
  registerLiveIpc(ctx, manager, mini)
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
  // Assistant threads: Relay says how each stands, their files hold the last reply; a thin client
  // takes the registry from the Mini's host.
  const assistants = registerAssistantsIpc(
    ctx,
    relay,
    sessionsDirs,
    ctx.env.relayRemote ? relay : null,
    (l) => notifier.onAssistants(l),
  )
  // Desktop notifications. A thin client hears the same things from the host: its assistants and
  // their replies, the Working list and the canvas rooms all come through Relay.
  const notifier = registerNotifications(
    ctx,
    (file) => assistants.list().agents.find((a) => a.file === file)?.id ?? null,
  )
  notifier.onAssistants(assistants.list())
  relay.watchActivity()
  const offNotifyActivity = relay.onActivity(() => notifier.onActivity(relay.activity()))
  const offNotifyRooms = relay.onCanvasRoomsChange(() => notifier.onRooms(relay.canvasRooms()))
  const emitList = (): void => {
    const l = list.list()
    emit(ctx, 'chat.listChanged', l)
    notifier.onChatList(l, alerts.update(l))
  }
  registerChatListIpc(ctx, queue, list, manager, sessionsDirs, emitList)
  // The host's dashboards, as Relay streams them.
  const offBoards = registerBoardsIpc(ctx, relay)
  // Tapbacks on the bubbles of the chats shown, as Relay keeps them for every device.
  const offReactions = registerReactionsIpc(ctx, relay)
  // The open questions of the assistant threads shown (the phone's badges), as the host keeps them.
  const offAsks = registerAsksIpc(ctx, relay)
  // What each thread holds (tickets, PRs, media, subagents), for the Artifacts panel.
  const offArtifacts = registerArtifactsIpc(ctx, relay)
  // What agents are running (helpers, sessions, harnesses, canvas), for the Working tab and the chips.
  const offActivity = registerActivityIpc(ctx, relay)
  // Live canvas rooms on the host, and the way into one (the Canvas page's frame).
  const offCanvasLive = registerCanvasLiveIpc(ctx, relay)
  // Skills on the host, for the Skills page: the list, access toggles, and the live editor's way in.
  registerSkillsIpc(ctx, relay)
  // Image and video jobs on the host, for the Studio page.
  const offStudio = registerStudioIpc(ctx, relay)
  // What the host's omp sessions cost, for Settings > Usage.
  const offStats = registerStatsIpc(ctx, relay)

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
    offAsks()
    offArtifacts()
    offActivity()
    offNotifyActivity()
    offNotifyRooms()
    offCanvasLive()
    offStudio()
    offStats()
    clearTimeout(statusTimer)
    assistants.close()
    await watch.close()
  })
  // Quit ends stdin on every omp this app started and waits; it never signals (D-17).
  ctx.onBeforeQuit(() => manager.closeAll())
  return {
    notifier,
    onSessionsChanged: (cb) => watch.onChange(cb),
    placeOf: (file) => list.placeOf(resolveInsideSessionsDir(sessionsDirs, file)),
    anyWorking: () => manager.anyWorking(),
    assistants: () => assistants.list(),
    relaySessions: () => relay.sessions(),
    sessionFile: (id) => {
      for (const dir of sessionsDirs) {
        let names: string[]
        try {
          names = fs.readdirSync(dir)
        } catch {
          continue
        }
        const name = names.find((n) => n.endsWith('.jsonl') && sessionId(n) === id)
        if (name !== undefined) return path.join(dir, name)
      }
      return null
    },
    artifacts: relay,
    canvas: relay,
    studio: relay,
    mini,
    frames: relay,
    hostInfo: () => relay.host(),
  }
}
