// The connection to Relay, kept up in the background and retried while Relay is down, ported from
// relay.rs (keep_connected, run_connection). One connection: read the port from serve.json, open
// ws://127.0.0.1:<port>/relay, pair through devices.json, say hello, answer the challenge, then
// keep the session list from `welcome`, `agents.snapshot` and `agents.delta`, the boards from
// `board.snapshot` and `board.delta`, the live canvas rooms from `canvas.rooms` and, once Studio
// is asked for, Studio's jobs from `studio.state` and `studio.job`, pinging every 10 s (Relay
// drops a peer that is quiet for a minute). Any failure drops the lists and retries in 3 s.
//
// Subscriptions outlive a connection: each new one subscribes again (native `remember`), and asks
// again for the reactions of every thread a chat shows. A command cannot wait for one: sent while
// Relay is down it fails at once, and one in flight when the connection drops fails with it.
//
// With a remote host (another Mac over Tailscale) it dials that instead and pairs with a PIN.
import type { ThreadReactions } from '@evaos/chat-core/reactions'
import type { Artifact, ArtifactAction, ArtifactTab } from '@evaos/chat-core/artifacts'
import type { ActivityItem } from '@evaos/chat-core/activity'
import {
  BoardQueryAnswerSchema,
  studioWithJob,
  studioWithLibrary,
  studioWithout,
  type Board,
  type BoardQueryAnswer,
  type CanvasRoom,
  type StudioAnswer,
  type StudioChange,
  type StudioOp,
  type StudioSegments,
  type StudioState,
} from '@evaos/contract'
import {
  Feed,
  RelayRefused,
  hello,
  type FeedEvent,
  type FeedOutput,
  type RelaySession,
} from './feed'
import {
  canvasOpenFrame,
  cmdFrame,
  reactionFrame,
  artifactsActFrame,
  artifactsGetFrame,
  ACTIVITY_GET_FRAME,
  reactionsGetFrame,
  bookmarkFrame,
  renderFailedFrame,
  type RenderFailureReport,
  bookmarksGetFrame,
  subscribeFrame,
  studioReqFrame,
  STUDIO_LIST_FRAME,
  unsubscribeFrame,
  type RelayCommand,
} from './commands'
import {
  bearer,
  deviceSecret,
  remoteAuthority,
  servePort,
  serveToken,
  type RelayRemote,
} from './device'

/** Between attempts while Relay is down. */
export const RETRY_MS = 3000
/** Relay drops a peer that's quiet for a minute. */
export const PING_MS = 10_000
/** How long a command may wait for its ack (the host gives omp 5 s, a configure a little more). */
export const COMMAND_TIMEOUT_MS = 20_000
const CONNECT_TIMEOUT_MS = 2000

export const NOT_RUNNING = "Relay isn't running."
export const CLOSED = 'Relay closed the connection.'
export const LOST = 'Lost the connection to Relay.'
export const NOT_CONNECTED = "Relay isn't connected."
export const NO_ANSWER = "Relay didn't answer in time."
/** An older Relay Host: no `welcome.features` "query", or no `/query` route. */
export const NO_QUERIES = "This Relay Host doesn't run live widget queries; update it."
/** `welcome.features` entry of a host that answers live widget queries. */
const QUERY_FEATURE = 'query'
/** `welcome.features` entry of a host that keeps turn bookmarks. */
const BOOKMARKS_FEATURE = 'bookmarks'
/** `welcome.features` entry of a host that takes `render.failed` reports. */
export const RENDER_REPORT_FEATURE = 'render.report'

export interface RelaySocket {
  send(text: string): void
  close(): void
}

export interface SocketHandlers {
  message(text: string): void
  /** The open socket closed, and why. Not called for a socket that never opened. */
  closed(reason: string): void
}

/** Opens a WebSocket to `url`: resolves once open, rejects when it cannot connect. */
export type Dial = (url: string, on: SocketHandlers) => Promise<RelaySocket>

/** What the chat list reads: Relay's sessions while connected. */
export interface RelaySource {
  /** Relay's sessions by id while connected; null while Relay is unreachable or turned this app away. */
  sessions(): ReadonlyMap<string, RelaySession> | null
  /** Called after every change of the connection or the session list. */
  onChange(cb: () => void): () => void
}

/** What a subscribed session says: its streamed reply, its questions and approvals. */
export type RelaySessionEvent = Exclude<
  FeedEvent,
  {
    kind:
      | 'sessions'
      | 'pin'
      | 'paired'
      | 'ack'
      | 'nack'
      | 'boards'
      | 'reactions'
      | 'bookmarks'
      | 'artifacts'
      | 'activity'
      | 'acted'
      | 'canvasRooms'
      | 'canvasAccess'
      | 'canvasUnavailable'
      | 'studioState'
      | 'studioJob'
      | 'studioLibrary'
      | 'studioSegments'
      | 'studioRemoved'
      | 'studioRes'
      | 'queryRes'
  }
>

/** Relay as the chat pane drives it: the session list, subscriptions and commands. */
export interface RelayLink extends RelaySource {
  /** Streams `sessionId`'s replies, asks and approvals, on this connection and every later one. */
  subscribe(sessionId: string): void
  unsubscribe(sessionId: string): void
  /** Resolves once Relay carried the command out; rejects with a RelayCommandError. `timeoutMs`
   * overrides the ack wait. */
  command(cmd: RelayCommand, timeoutMs?: number): Promise<void>
  onEvent(cb: (e: RelaySessionEvent) => void): () => void
  /** The host's dashboards by title while connected; null until Relay sends them and while down. */
  boards(): readonly Board[] | null
  /** Called after every change of the boards, including Relay going down. */
  onBoardsChange(cb: () => void): () => void
}

/** The Relay Host this app is connected to, as its `welcome` named it (null while not connected). */
export interface RelayHostInfo {
  host(): { name: string; version: string } | null
}

/** Live widgets' data (board tiles, canvas `ui` cards): the host's read-only query tools. */
export interface RelayQueries {
  /** Connected to a host that answers live widget queries (`welcome.features` has "query"). */
  queriesUp(): boolean
  /**
   * Runs one read-only host query tool for a live widget: loopback `POST /query` on the local
   * host, the `query.req` frame on a remote one. Never rejects; `unsupported` means the host is
   * too old to answer, so the widget should show its static spec.
   */
  query(tool: string, args: Record<string, unknown>): Promise<BoardQueryAnswer>
}

/** Raw frames of an authenticated connection (the remote session mirror's requests and answers). */
export interface RelayFrames {
  onFrame(cb: (frame: Record<string, unknown>) => void): () => void
  /** Sends `frame` on an authenticated connection; false while there is none. */
  sendFrame(frame: Record<string, unknown>): boolean
}

/** What the connected host answers beyond the base protocol. */
export interface RelayFeatures {
  /** Whether the connected, authenticated host lists `feature` in `welcome.features`. */
  hostHas(feature: string): boolean
}

/**
 * Tapbacks on chat bubbles: the threads the app shows, as the host's snapshots have them. Sending
 * is fire and forget; the host pushes the thread's new snapshot to every device, this one too.
 */
export interface RelayReactions {
  /** Connected and authenticated, so a reaction can go out now. */
  reactionsUp(): boolean
  /** `thread`'s reactions as the host last sent them; empty before its first snapshot. */
  reactions(thread: string): ThreadReactions
  /** Asks for `thread`'s reactions now (when connected) and after every reconnect. */
  watchReactions(thread: string): void
  unwatchReactions(thread: string): void
  /** Sets (`emoji`) or clears (null) a bubble's reaction; false when nothing could be sent. */
  react(thread: string, message: string, emoji: string | null, excerpt: string): boolean
  /** Called with the thread after each of its snapshots. */
  onReactions(cb: (thread: string) => void): () => void
  /** Connected to a host that keeps bookmarks (`welcome.features` has "bookmarks"). */
  bookmarksUp(): boolean
  /** `thread`'s bookmarked turns (reaction keys) as the host last sent them; null before its first snapshot. */
  bookmarks(thread: string): string[] | null
  /** Bookmarks (`on`) or unbookmarks a turn; false when nothing could be sent. */
  bookmark(thread: string, message: string, on: boolean): boolean
}

/** Media render failures, told to the host so the owning agent can repost a working form. */
export interface RelayRender {
  /** Sends `failure` when the host takes "render.report"; false (dropped) otherwise. */
  reportRender(failure: RenderFailureReport): boolean
}

/** A thread's artifacts and tab bar, as the host's latest `artifacts.snapshot` has them. */
export interface ArtifactsSnapshot {
  items: Artifact[]
  tabs: ArtifactTab[]
}

/** The host's answer to one `artifacts.act`; `id` is the new item's or tab's. */
export interface ArtifactsActed {
  ok: boolean
  error?: string
  id?: string
}

/**
 * What threads hold (tickets, PRs, links, media, subagents) and their tab bars. The host pushes
 * every thread's snapshot after each change, so every snapshot heard is kept, watched or not.
 */
export interface RelayArtifacts {
  /** Connected and authenticated, so an action can go out now. */
  artifactsUp(): boolean
  /** `thread`'s artifacts as the host last sent them; null before its first snapshot. */
  artifacts(thread: string): ArtifactsSnapshot | null
  /** Every thread heard from, with its last snapshot. */
  artifactThreads(): ReadonlyMap<string, ArtifactsSnapshot>
  /** Asks for `thread`'s artifacts now (when connected) and after every reconnect. */
  watchArtifacts(thread: string): void
  unwatchArtifacts(thread: string): void
  /** Does `action` on `thread` as `by`; resolves with the host's answer, never rejects. */
  actArtifacts(thread: string, by: string, action: ArtifactAction): Promise<ArtifactsActed>
  /** Called with the thread after each snapshot of any thread. */
  onArtifacts(cb: (thread: string) => void): () => void
}

/** Everything agents are running, as the host last sent it. */
export interface RelayActivity {
  /** The host's latest `activity.snapshot`; empty before its first. */
  activity(): readonly ActivityItem[]
  /** Asks for the list now (when connected) and after every reconnect. */
  watchActivity(): void
  /** Called after each snapshot. */
  onActivity(cb: () => void): () => void
}

/** The host's answer to `canvas.open`: the room page's host-relative path, or why there is none. */
export type CanvasAccess =
  { ok: true; path: string; expiresAt: number } | { ok: false; error: string }

/** An access is reused while it has this long left (the host's tokens last 12 hours). */
const ACCESS_MARGIN_MS = 60_000

/** The live canvas rooms the host holds, and the way into one. */
export interface RelayCanvas {
  /** Every room the host holds while connected; null until Relay sends them and while down. */
  canvasRooms(): readonly CanvasRoom[] | null
  /** Called after every change of the rooms, including Relay going down. */
  onCanvasRoomsChange(cb: () => void): () => void
  /** The host's http origin (`http://127.0.0.1:<port>`), null when no host is running. */
  canvasOrigin(): string | null
  /** The bearer token the local host's loopback write routes require; null when no host is running. */
  hostToken(): string | null
  /** Asks the host into the live room on `slug`; resolves with its page or why not, never rejects. */
  openCanvas(slug: string): Promise<CanvasAccess>
}

/**
 * Studio on the host (image and video jobs, a queue, a gallery). Nothing is asked until the first
 * `studioList`; from then on every connection asks again, and every change is kept and passed on.
 */
export interface RelayStudio {
  /** Connected and authenticated, so an op can go out now. */
  studioUp(): boolean
  /** Studio as the host last sent it (kept while Relay is down); null before its first state. */
  studio(): StudioState | null
  /** SAM 2.1 results heard so far (answers and `studio.segments`), by image asset id. */
  studioSegments(): Readonly<Record<string, StudioSegments>>
  /**
   * Asks the host for Studio now (when connected) and after every reconnect; resolves with the
   * state once it answers, or with what is known when it cannot (down, no answer in time).
   */
  studioList(): Promise<StudioState | null>
  /** Sends one op; resolves with the host's answer, never rejects. */
  studioRequest(op: StudioOp): Promise<StudioAnswer>
  /** Called after each change heard (a whole state, one job, a deletion, the library, segments). */
  onStudio(cb: (change: StudioChange) => void): () => void
}

/**
 * Relay didn't carry a command out. `code` is Relay's AckError code (`agent_cannot_respond`,
 * `agent_not_found`, `biometric_required`, ...) or `not_connected` / `timeout` from here.
 */
export class RelayCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Dials with the WebSocket built into Node and Electron's main process. */
export const dialWebSocket: Dial = (url, on) => {
  const { promise, resolve, reject } = Promise.withResolvers<RelaySocket>()
  const ws = new WebSocket(url)
  let open = false
  const timer = setTimeout(() => {
    ws.close()
    reject(new Error('timed out'))
  }, CONNECT_TIMEOUT_MS)
  ws.onopen = () => {
    open = true
    clearTimeout(timer)
    resolve({
      send: (text) => ws.send(text),
      close: () => ws.close(),
    })
  }
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data === 'string') on.message(e.data)
  }
  ws.onclose = (e: CloseEvent) => {
    clearTimeout(timer)
    if (open) on.closed(e.wasClean ? CLOSED : LOST)
    else reject(new Error('could not connect'))
  }
  return promise
}

export interface RelayClientOptions {
  /** Relay's config folder (`relayConfigDir`); unused with `remote`. */
  configDir: string | null
  /** A Relay Host on another Mac, dialed instead of the local one. */
  remote?: RemoteHost
  dial?: Dial
  /** Test seam: this app's paired secret. */
  secret?: (configDir: string) => Uint8Array
  retryMs?: number
  pingMs?: number
  commandTimeoutMs?: number
  now?: () => number
  /** How long an `artifacts.act` may wait for its `artifacts.acted`. */
  actTimeoutMs?: number
  /** Test seam: the HTTP client for loopback `POST /query`. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

/** A Relay Host on another Mac: paired with a PIN, never through its `devices.json`. */
export interface RemoteHost extends RelayRemote {
  deviceId: string
  /** The secret a pairing gave this app for this host, null before the first. */
  secret(): Uint8Array | null
  save(secret: Uint8Array): void
  /** The PIN Isaac reads in the Relay Host log; null when he cancels. */
  askPin(retry: boolean): Promise<string | null>
}

interface Pending {
  resolve(): void
  reject(e: RelayCommandError): void
  timer: NodeJS.Timeout
}

/** Keeps a connection to Relay up while started; `sessions()` is null whenever it is down. */
export class RelayClient
  implements
    RelayLink,
    RelayReactions,
    RelayArtifacts,
    RelayActivity,
    RelayCanvas,
    RelayFrames,
    RelayFeatures,
    RelayStudio,
    RelayQueries,
    RelayHostInfo,
    RelayRender
{
  private readonly dial: Dial
  private readonly secret: (configDir: string) => Uint8Array
  private readonly retryMs: number
  private readonly pingMs: number
  private readonly commandTimeoutMs: number
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private readonly frameListeners = new Set<(frame: Record<string, unknown>) => void>()
  private readonly boardListeners = new Set<() => void>()
  private readonly eventListeners = new Set<(e: RelaySessionEvent) => void>()
  private readonly subscriptions = new Set<string>()
  private readonly reactionListeners = new Set<(thread: string) => void>()
  /** Threads a chat shows; asked for again on every connection. */
  private readonly reactionThreads = new Set<string>()
  /** The last snapshot of each thread; kept while Relay is down so badges stay. */
  private readonly reactionMap = new Map<string, ThreadReactions>()
  /** The last bookmarks snapshot of each watched thread (a host with the "bookmarks" feature). */
  private readonly bookmarkMap = new Map<string, string[]>()
  private readonly artifactListeners = new Set<(thread: string) => void>()
  /** Threads a panel shows; asked for again on every connection. */
  private readonly artifactWatch = new Set<string>()
  /** The last snapshot of every thread heard from; kept while Relay is down. */
  private readonly artifactMap = new Map<string, ArtifactsSnapshot>()
  private activityRows: readonly ActivityItem[] = []
  private activityWatched = false
  private readonly activityListeners = new Set<() => void>()
  /** Artifact actions sent on this connection, by rid, until Relay answers. */
  private readonly acts = new Map<
    string,
    { resolve(r: ArtifactsActed): void; timer: NodeJS.Timeout }
  >()
  /** Commands sent on this connection, by id, until Relay answers. */
  private readonly pending = new Map<string, Pending>()
  private readonly canvasListeners = new Set<() => void>()
  /** `canvas.open` requests sent on this connection, by slug, until Relay answers. */
  private readonly canvasOpens = new Map<
    string,
    { waiters: Array<(a: CanvasAccess) => void>; timer: NodeJS.Timeout }
  >()
  /** The last access to each slug's room on this connection, reused until near its expiry. */
  private readonly canvasAccess = new Map<string, { path: string; expiresAt: number }>()
  private canvasList: readonly CanvasRoom[] | null = null
  private readonly studioListeners = new Set<(change: StudioChange) => void>()
  /** Asked for once, so every new connection asks again. */
  private studioWatched = false
  private studioSnap: StudioState | null = null
  private studioSegs: Record<string, StudioSegments> = {}
  /** `studioList` calls waiting for the host's next `studio.state`. */
  private studioWaiters: Array<(state: StudioState | null) => void> = []
  private studioWaitTimer: NodeJS.Timeout | undefined
  /** Studio ops sent on this connection, by rid, until Relay answers. */
  private readonly studioReqs = new Map<
    string,
    { resolve(r: StudioAnswer): void; timer: NodeJS.Timeout }
  >()
  /** Live widget queries sent on this connection (remote hosts), by rid, until Relay answers. */
  private readonly queryReqs = new Map<
    string,
    { resolve(r: BoardQueryAnswer): void; timer: NodeJS.Timeout }
  >()
  /** The http origin of the host this connection reached. */
  private origin: string | null = null
  private commands = 0
  private list: ReadonlyMap<string, RelaySession> | null = null
  private boardList: readonly Board[] | null = null
  private reason: string | null = null
  private socket: RelaySocket | null = null
  private feed: Feed | null = null
  /** Grows with every connection attempt, so a stale socket's callbacks are ignored. */
  private attempt = 0
  private started = false
  private retryTimer: NodeJS.Timeout | undefined
  private pingTimer: NodeJS.Timeout | undefined

  constructor(private readonly o: RelayClientOptions) {
    this.dial = o.dial ?? dialWebSocket
    this.secret = o.secret ?? ((dir) => deviceSecret(dir))
    this.retryMs = o.retryMs ?? RETRY_MS
    this.pingMs = o.pingMs ?? PING_MS
    this.commandTimeoutMs = o.commandTimeoutMs ?? COMMAND_TIMEOUT_MS
    this.now = o.now ?? Date.now
  }

  sessions(): ReadonlyMap<string, RelaySession> | null {
    return this.list
  }

  boards(): readonly Board[] | null {
    return this.boardList
  }

  onBoardsChange(cb: () => void): () => void {
    this.boardListeners.add(cb)
    return () => this.boardListeners.delete(cb)
  }

  queriesUp(): boolean {
    return this.feed?.authenticated === true && this.feed.features.includes(QUERY_FEATURE)
  }

  host(): { name: string; version: string } | null {
    return this.feed?.authenticated === true ? this.feed.host : null
  }

  async query(tool: string, args: Record<string, unknown>): Promise<BoardQueryAnswer> {
    if (!this.feed?.authenticated) return { ok: false, error: NOT_CONNECTED }
    if (!this.queriesUp()) return { ok: false, error: NO_QUERIES, unsupported: true }
    if (this.o.remote) return this.queryFrame(tool, args)
    const origin = this.origin
    if (origin === null) return { ok: false, error: NOT_CONNECTED }
    let res: Response
    try {
      res = await (this.o.fetch ?? fetch)(`${origin}/query`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...bearer(this.o.configDir === null ? null : serveToken(this.o.configDir)),
        },
        body: JSON.stringify({ tool, args }),
        signal: AbortSignal.timeout(this.commandTimeoutMs),
      })
    } catch (e) {
      return { ok: false, error: `Couldn't reach Relay: ${(e as Error).message}` }
    }
    // No route: a host older than its welcome said (or one with queries turned off).
    if (res.status === 404 || res.status === 405)
      return { ok: false, error: NO_QUERIES, unsupported: true }
    const body = BoardQueryAnswerSchema.safeParse(await res.json().catch(() => null))
    if (!body.success) return { ok: false, error: `Relay answered ${String(res.status)}.` }
    return body.data.ok
      ? { ok: true, data: body.data.data }
      : { ok: false, error: body.data.error ?? `Relay answered ${String(res.status)}.` }
  }

  /** A remote host's query, over the connection (its `/query` is loopback only). */
  private queryFrame(tool: string, args: Record<string, unknown>): Promise<BoardQueryAnswer> {
    this.commands += 1
    const rid = `relay-desktop-query-${this.now()}-${this.commands}`
    const { promise, resolve } = Promise.withResolvers<BoardQueryAnswer>()
    const timer = setTimeout(() => {
      this.queryReqs.delete(rid)
      resolve({ ok: false, error: NO_ANSWER })
    }, this.commandTimeoutMs)
    this.queryReqs.set(rid, { resolve, timer })
    this.send({ t: 'query.req', rid, tool, args })
    return promise
  }

  /** Why Relay is down, while it is (null before the first attempt ends and while connected). */
  down(): string | null {
    return this.reason
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  onFrame(cb: (frame: Record<string, unknown>) => void): () => void {
    this.frameListeners.add(cb)
    return () => this.frameListeners.delete(cb)
  }

  sendFrame(frame: Record<string, unknown>): boolean {
    if (!this.feed?.authenticated) return false
    this.send(frame)
    return true
  }

  hostHas(feature: string): boolean {
    return this.feed?.authenticated === true && this.feed.features.includes(feature)
  }

  onEvent(cb: (e: RelaySessionEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  subscribe(sessionId: string): void {
    if (this.subscriptions.has(sessionId)) return
    this.subscriptions.add(sessionId)
    if (this.feed?.authenticated) this.send(subscribeFrame(sessionId))
  }

  unsubscribe(sessionId: string): void {
    if (!this.subscriptions.delete(sessionId)) return
    if (this.feed?.authenticated) this.send(unsubscribeFrame(sessionId))
  }

  reactionsUp(): boolean {
    return this.feed?.authenticated === true
  }

  reactions(thread: string): ThreadReactions {
    return this.reactionMap.get(thread) ?? {}
  }

  watchReactions(thread: string): void {
    this.reactionThreads.add(thread)
    if (this.feed?.authenticated) this.send(reactionsGetFrame(thread))
    if (this.bookmarksUp()) this.send(bookmarksGetFrame(thread))
  }

  unwatchReactions(thread: string): void {
    this.reactionThreads.delete(thread)
    this.reactionMap.delete(thread)
    this.bookmarkMap.delete(thread)
  }

  react(thread: string, message: string, emoji: string | null, excerpt: string): boolean {
    if (!this.feed?.authenticated) return false
    this.send(reactionFrame(thread, message, emoji, excerpt))
    return true
  }

  onReactions(cb: (thread: string) => void): () => void {
    this.reactionListeners.add(cb)
    return () => this.reactionListeners.delete(cb)
  }

  bookmarksUp(): boolean {
    return this.hostHas(BOOKMARKS_FEATURE)
  }

  bookmarks(thread: string): string[] | null {
    return this.bookmarkMap.get(thread) ?? null
  }

  bookmark(thread: string, message: string, on: boolean): boolean {
    if (!this.bookmarksUp()) return false
    this.send(bookmarkFrame(thread, message, on))
    return true
  }

  reportRender(failure: RenderFailureReport): boolean {
    if (!this.hostHas(RENDER_REPORT_FEATURE)) return false
    this.send(renderFailedFrame(failure))
    return true
  }

  artifactsUp(): boolean {
    return this.feed?.authenticated === true
  }

  artifacts(thread: string): ArtifactsSnapshot | null {
    return this.artifactMap.get(thread) ?? null
  }

  artifactThreads(): ReadonlyMap<string, ArtifactsSnapshot> {
    return this.artifactMap
  }

  watchArtifacts(thread: string): void {
    this.artifactWatch.add(thread)
    if (this.feed?.authenticated) this.send(artifactsGetFrame(thread))
  }

  unwatchArtifacts(thread: string): void {
    this.artifactWatch.delete(thread)
  }

  actArtifacts(thread: string, by: string, action: ArtifactAction): Promise<ArtifactsActed> {
    if (!this.feed?.authenticated) return Promise.resolve({ ok: false, error: NOT_CONNECTED })
    this.commands += 1
    const rid = `relay-desktop-act-${this.now()}-${this.commands}`
    const { promise, resolve } = Promise.withResolvers<ArtifactsActed>()
    const timer = setTimeout(() => {
      this.acts.delete(rid)
      resolve({ ok: false, error: NO_ANSWER })
    }, this.o.actTimeoutMs ?? this.commandTimeoutMs)
    this.acts.set(rid, { resolve, timer })
    this.send(artifactsActFrame(thread, rid, by, action))
    return promise
  }

  onArtifacts(cb: (thread: string) => void): () => void {
    this.artifactListeners.add(cb)
    return () => this.artifactListeners.delete(cb)
  }

  activity(): readonly ActivityItem[] {
    return this.activityRows
  }

  watchActivity(): void {
    this.activityWatched = true
    if (this.feed?.authenticated) this.send(ACTIVITY_GET_FRAME)
  }

  onActivity(cb: () => void): () => void {
    this.activityListeners.add(cb)
    return () => this.activityListeners.delete(cb)
  }

  canvasRooms(): readonly CanvasRoom[] | null {
    return this.canvasList
  }

  onCanvasRoomsChange(cb: () => void): () => void {
    this.canvasListeners.add(cb)
    return () => this.canvasListeners.delete(cb)
  }

  hostToken(): string | null {
    return this.o.remote || this.o.configDir === null ? null : serveToken(this.o.configDir)
  }

  canvasOrigin(): string | null {
    if (this.origin !== null) return this.origin
    const target = this.target()
    return target === null ? null : `http://${target}`
  }

  /** `host:port` to dial: the remote host, else the local one's port from `serve.json`. */
  private target(): string | null {
    if (this.o.remote) return remoteAuthority(this.o.remote)
    const port = this.o.configDir === null ? null : servePort(this.o.configDir)
    return port === null ? null : `127.0.0.1:${port}`
  }

  openCanvas(slug: string): Promise<CanvasAccess> {
    if (!this.feed?.authenticated) return Promise.resolve({ ok: false, error: NOT_CONNECTED })
    const known = this.canvasAccess.get(slug)
    if (known && known.expiresAt - this.now() > ACCESS_MARGIN_MS) {
      return Promise.resolve({ ok: true, ...known })
    }
    const { promise, resolve } = Promise.withResolvers<CanvasAccess>()
    const asked = this.canvasOpens.get(slug)
    if (asked) {
      asked.waiters.push(resolve)
      return promise
    }
    const timer = setTimeout(
      () => this.answerCanvas(slug, { ok: false, error: NO_ANSWER }),
      this.commandTimeoutMs,
    )
    this.canvasOpens.set(slug, { waiters: [resolve], timer })
    this.send(canvasOpenFrame(slug))
    return promise
  }

  /** Settles every `openCanvas` waiting on `slug`. */
  private answerCanvas(slug: string, access: CanvasAccess): void {
    const asked = this.canvasOpens.get(slug)
    if (!asked) return
    this.canvasOpens.delete(slug)
    clearTimeout(asked.timer)
    for (const resolve of asked.waiters) resolve(access)
  }

  studioUp(): boolean {
    return this.feed?.authenticated === true
  }

  studio(): StudioState | null {
    return this.studioSnap
  }

  studioSegments(): Readonly<Record<string, StudioSegments>> {
    return this.studioSegs
  }

  studioList(): Promise<StudioState | null> {
    this.studioWatched = true
    if (!this.feed?.authenticated) return Promise.resolve(this.studioSnap)
    const { promise, resolve } = Promise.withResolvers<StudioState | null>()
    this.studioWaiters.push(resolve)
    if (this.studioWaiters.length === 1) {
      this.studioWaitTimer = setTimeout(() => this.answerStudioList(), this.commandTimeoutMs)
      this.send(STUDIO_LIST_FRAME)
    }
    return promise
  }

  /** Settles every `studioList` waiting, with Studio as known now. */
  private answerStudioList(): void {
    clearTimeout(this.studioWaitTimer)
    this.studioWaitTimer = undefined
    for (const resolve of this.studioWaiters.splice(0)) resolve(this.studioSnap)
  }

  studioRequest(op: StudioOp): Promise<StudioAnswer> {
    if (!this.feed?.authenticated) return Promise.resolve({ ok: false, error: NOT_CONNECTED })
    this.commands += 1
    const rid = `relay-desktop-studio-${this.now()}-${this.commands}`
    const { promise, resolve } = Promise.withResolvers<StudioAnswer>()
    const timer = setTimeout(() => {
      this.studioReqs.delete(rid)
      resolve({ ok: false, error: NO_ANSWER })
    }, this.commandTimeoutMs)
    this.studioReqs.set(rid, { resolve, timer })
    this.send(studioReqFrame(rid, op))
    return promise
  }

  onStudio(cb: (change: StudioChange) => void): () => void {
    this.studioListeners.add(cb)
    return () => this.studioListeners.delete(cb)
  }

  /** Keeps `change` in the snapshot and passes it on. */
  private changeStudio(change: StudioChange): void {
    if (change.kind === 'state') this.studioSnap = change.state
    else if (change.kind === 'job' && this.studioSnap)
      this.studioSnap = studioWithJob(this.studioSnap, change.job)
    else if (change.kind === 'removed' && this.studioSnap)
      this.studioSnap = studioWithout(this.studioSnap, change.id)
    else if (change.kind === 'library' && this.studioSnap)
      this.studioSnap = studioWithLibrary(this.studioSnap, change.library)
    else if (change.kind === 'segments')
      this.studioSegs = { ...this.studioSegs, [change.segments.asset]: change.segments }
    for (const cb of [...this.studioListeners]) cb(change)
  }

  /** `timeoutMs` overrides the ack wait for a command the host may take longer to answer. */
  command(cmd: RelayCommand, timeoutMs: number = this.commandTimeoutMs): Promise<void> {
    if (!this.feed?.authenticated) {
      return Promise.reject(new RelayCommandError('not_connected', NOT_CONNECTED))
    }
    this.commands += 1
    const id = `relay-desktop-${this.now()}-${this.commands}`
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      reject(new RelayCommandError('timeout', NO_ANSWER))
    }, timeoutMs)
    this.pending.set(id, { resolve, reject, timer })
    this.send(cmdFrame(id, cmd))
    return promise
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.connect()
  }

  stop(): void {
    this.started = false
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.drop(NOT_CONNECTED)
    this.setList(null)
    this.setBoards(null)
    this.setCanvasRooms(null)
  }

  private async connect(): Promise<void> {
    this.retryTimer = undefined
    const attempt = ++this.attempt
    const target = this.target()
    if (target === null) return this.fail(NOT_RUNNING)
    let socket: RelaySocket
    try {
      socket = await this.dial(`ws://${target}/relay`, {
        message: (text) => {
          if (attempt === this.attempt) this.receive(text)
        },
        closed: (reason) => {
          if (attempt === this.attempt) this.fail(reason)
        },
      })
    } catch {
      if (attempt === this.attempt) this.fail(NOT_RUNNING)
      return
    }
    if (attempt !== this.attempt || !this.started) return socket.close()
    const remote = this.o.remote
    let secret: Uint8Array | null
    try {
      // A remote host's devices are its own; this app keeps the secret its pairing gave.
      secret = remote ? remote.secret() : this.secret(this.o.configDir!)
    } catch (e) {
      socket.close()
      return this.fail(`Couldn't add this app to Relay's devices: ${(e as Error).message}`)
    }
    this.socket = socket
    this.origin = `http://${target}`
    this.feed = new Feed(secret, remote !== undefined)
    this.send(hello(remote?.deviceId))
  }

  private receive(text: string): void {
    const feed = this.feed
    if (!feed) return
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    let out: FeedOutput
    try {
      out = feed.receive(frame)
    } catch (e) {
      return this.fail(e instanceof RelayRefused ? e.message : `Relay: ${(e as Error).message}`)
    }
    for (const reply of out.replies) this.send(reply)
    if (feed.authenticated && !this.pingTimer) {
      this.reason = null
      this.pingTimer = setInterval(() => this.send({ t: 'ping', ts: this.now() }), this.pingMs)
      for (const id of this.subscriptions) this.send(subscribeFrame(id))
      for (const thread of this.reactionThreads) this.send(reactionsGetFrame(thread))
      for (const thread of this.reactionThreads) {
        if (feed.features.includes(BOOKMARKS_FEATURE)) this.send(bookmarksGetFrame(thread))
      }
      for (const thread of this.artifactWatch) this.send(artifactsGetFrame(thread))
      if (this.activityWatched) this.send(ACTIVITY_GET_FRAME)
      if (this.studioWatched) this.send(STUDIO_LIST_FRAME)
    }
    if (feed.authenticated && typeof frame === 'object' && frame !== null) {
      for (const cb of this.frameListeners) cb(frame as Record<string, unknown>)
    }
    for (const event of out.events) {
      switch (event.kind) {
        case 'sessions':
          this.setList(new Map(event.sessions.map((s) => [s.id, s])))
          break
        case 'boards':
          this.setBoards(event.boards)
          break
        case 'reactions':
          // Only threads a chat shows are kept; a push for another is someone else's.
          if (!this.reactionThreads.has(event.thread)) break
          this.reactionMap.set(event.thread, event.reactions)
          for (const cb of [...this.reactionListeners]) cb(event.thread)
          break
        case 'bookmarks':
          if (!this.reactionThreads.has(event.thread)) break
          this.bookmarkMap.set(event.thread, event.messages)
          for (const cb of [...this.reactionListeners]) cb(event.thread)
          break
        case 'artifacts':
          this.artifactMap.set(event.thread, { items: event.items, tabs: event.tabs })
          for (const cb of [...this.artifactListeners]) cb(event.thread)
          break
        case 'activity':
          this.activityRows = event.items
          for (const cb of [...this.activityListeners]) cb()
          break
        case 'acted': {
          const a = this.acts.get(event.rid)
          if (!a) break
          this.acts.delete(event.rid)
          clearTimeout(a.timer)
          a.resolve({
            ok: event.ok,
            ...(event.error === undefined ? {} : { error: event.error }),
            ...(event.id === undefined ? {} : { id: event.id }),
          })
          break
        }
        case 'canvasRooms': {
          // An ended room's access is no good any more.
          const live = new Set(event.rooms.filter((r) => r.live).map((r) => r.slug))
          for (const slug of [...this.canvasAccess.keys()])
            if (!live.has(slug)) this.canvasAccess.delete(slug)
          this.setCanvasRooms(event.rooms)
          break
        }
        case 'canvasAccess': {
          const access = { path: event.path, expiresAt: event.expiresAt }
          this.canvasAccess.set(event.slug, access)
          this.answerCanvas(event.slug, { ok: true, ...access })
          break
        }
        case 'canvasUnavailable':
          this.canvasAccess.delete(event.slug)
          this.answerCanvas(event.slug, {
            ok: false,
            error: event.reason || 'This canvas session has ended.',
          })
          break
        case 'studioState':
          this.changeStudio({ kind: 'state', state: event.state })
          this.answerStudioList()
          break
        case 'studioJob':
          this.changeStudio({ kind: 'job', job: event.job })
          break
        case 'studioLibrary':
          this.changeStudio({ kind: 'library', library: event.library })
          break
        case 'studioSegments':
          this.changeStudio({ kind: 'segments', segments: event.segments })
          break
        case 'studioRemoved':
          this.changeStudio({ kind: 'removed', id: event.id })
          break
        case 'studioRes': {
          const s = this.studioReqs.get(event.rid)
          if (!s) break
          this.studioReqs.delete(event.rid)
          clearTimeout(s.timer)
          if (event.answer.segments) {
            this.changeStudio({ kind: 'segments', segments: event.answer.segments })
          }
          s.resolve(event.answer)
          break
        }
        case 'queryRes': {
          const q = this.queryReqs.get(event.rid)
          if (!q) break
          this.queryReqs.delete(event.rid)
          clearTimeout(q.timer)
          q.resolve(
            event.ok
              ? { ok: true, data: event.data }
              : { ok: false, error: event.error ?? "Relay couldn't run that query." },
          )
          break
        }
        case 'ack':
        case 'nack': {
          const p = this.pending.get(event.id)
          if (!p) break
          this.pending.delete(event.id)
          clearTimeout(p.timer)
          if (event.kind === 'ack') p.resolve()
          else p.reject(new RelayCommandError(event.code, event.message))
          break
        }
        case 'pin':
          void this.askPin(event.retry)
          break
        case 'paired':
          this.o.remote?.save(event.secret)
          break
        default:
          for (const cb of [...this.eventListeners]) cb(event)
      }
    }
  }

  /** Asks Isaac for the remote host's PIN and confirms it on the connection that asked. */
  private async askPin(retry: boolean): Promise<void> {
    const attempt = this.attempt
    const pin = await this.o.remote!.askPin(retry)
    if (attempt !== this.attempt) return
    if (pin === null) return this.fail('Pairing with Relay Host was cancelled.')
    this.send({ t: 'pair.confirm', pin })
  }

  private send(frame: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(frame))
    } catch {
      // The socket is closing; its close callback reports why.
    }
  }

  /** Ends the connection (if any), drops the list and retries after a pause. */
  private fail(reason: string): void {
    this.drop(reason)
    this.reason = reason
    this.setList(null)
    this.setBoards(null)
    this.setCanvasRooms(null)
    if (this.started && !this.retryTimer) {
      this.retryTimer = setTimeout(() => void this.connect(), this.retryMs)
    }
  }

  /** Closes the current socket and fails its commands; its callbacks are ignored from here on. */
  private drop(reason: string): void {
    this.attempt++
    clearInterval(this.pingTimer)
    this.pingTimer = undefined
    const socket = this.socket
    this.socket = null
    this.feed = null
    socket?.close()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new RelayCommandError('not_connected', reason))
    }
    this.pending.clear()
    for (const a of this.acts.values()) {
      clearTimeout(a.timer)
      a.resolve({ ok: false, error: reason })
    }
    this.acts.clear()
    for (const s of this.studioReqs.values()) {
      clearTimeout(s.timer)
      s.resolve({ ok: false, error: reason })
    }
    this.studioReqs.clear()
    for (const q of this.queryReqs.values()) {
      clearTimeout(q.timer)
      q.resolve({ ok: false, error: reason })
    }
    this.queryReqs.clear()
    this.answerStudioList()
    for (const slug of [...this.canvasOpens.keys()])
      this.answerCanvas(slug, { ok: false, error: reason })
    // A new connection may reach another host, whose tokens these are not.
    this.canvasAccess.clear()
    this.origin = null
  }

  private setList(list: ReadonlyMap<string, RelaySession> | null): void {
    if (list === null && this.list === null) return
    this.list = list
    for (const cb of this.listeners) cb()
  }

  private setBoards(boards: readonly Board[] | null): void {
    if (boards === null && this.boardList === null) return
    this.boardList = boards
    for (const cb of this.boardListeners) cb()
  }

  private setCanvasRooms(rooms: readonly CanvasRoom[] | null): void {
    if (rooms === null && this.canvasList === null) return
    this.canvasList = rooms
    for (const cb of this.canvasListeners) cb()
  }
}

/** A Relay that is never connected: fixtures and e2e, unless a test sets sessions. */
export class StaticRelay
  implements
    RelayLink,
    RelayReactions,
    RelayArtifacts,
    RelayActivity,
    RelayCanvas,
    RelayFrames,
    RelayFeatures,
    RelayStudio,
    RelayQueries,
    RelayHostInfo,
    RelayRender
{
  private list: ReadonlyMap<string, RelaySession> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly artifactMap = new Map<string, ArtifactsSnapshot>()
  private readonly artifactListeners = new Set<(thread: string) => void>()
  private activityRows: readonly ActivityItem[] = []
  private readonly activityListeners = new Set<() => void>()

  sessions(): ReadonlyMap<string, RelaySession> | null {
    return this.list
  }

  /** Never connected, so no host. */
  host(): null {
    return null
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Never connected, so never any Studio and every op fails. */
  studioUp(): boolean {
    return false
  }

  studio(): StudioState | null {
    return null
  }

  studioSegments(): Readonly<Record<string, StudioSegments>> {
    return {}
  }

  studioList(): Promise<StudioState | null> {
    return Promise.resolve(null)
  }

  studioRequest(): Promise<StudioAnswer> {
    return Promise.resolve({ ok: false, error: NOT_CONNECTED })
  }

  onStudio(): () => void {
    return () => undefined
  }

  onEvent(): () => void {
    return () => undefined
  }

  /** Never connected: no frames are heard nor sent. */
  onFrame(): () => void {
    return () => undefined
  }

  sendFrame(): boolean {
    return false
  }

  hostHas(): boolean {
    return false
  }

  /** Never connected, so never any boards. */
  boards(): readonly Board[] | null {
    return null
  }

  onBoardsChange(): () => void {
    return () => undefined
  }

  queriesUp(): boolean {
    return false
  }

  query(): Promise<BoardQueryAnswer> {
    return Promise.resolve({ ok: false, error: NOT_CONNECTED })
  }

  /** Never connected, so never any canvas rooms nor a way into one. */
  canvasRooms(): readonly CanvasRoom[] | null {
    return null
  }

  onCanvasRoomsChange(): () => void {
    return () => undefined
  }

  canvasOrigin(): string | null {
    return null
  }

  hostToken(): string | null {
    return null
  }

  openCanvas(): Promise<CanvasAccess> {
    return Promise.resolve({ ok: false, error: NOT_CONNECTED })
  }

  subscribe(): void {}

  unsubscribe(): void {}

  /** Never connected: reactions are never sent nor heard. */
  reactionsUp(): boolean {
    return false
  }

  reactions(): ThreadReactions {
    return {}
  }

  watchReactions(): void {}

  unwatchReactions(): void {}

  react(): boolean {
    return false
  }

  onReactions(): () => void {
    return () => undefined
  }

  bookmarksUp(): boolean {
    return false
  }

  bookmarks(): string[] | null {
    return null
  }

  bookmark(): boolean {
    return false
  }

  reportRender(): boolean {
    return false
  }

  /** Never connected, so actions fail; snapshots only come from `setArtifacts` (tests, fixtures). */
  artifactsUp(): boolean {
    return false
  }

  artifacts(thread: string): ArtifactsSnapshot | null {
    return this.artifactMap.get(thread) ?? null
  }

  artifactThreads(): ReadonlyMap<string, ArtifactsSnapshot> {
    return this.artifactMap
  }

  watchArtifacts(): void {}

  unwatchArtifacts(): void {}

  actArtifacts(): Promise<ArtifactsActed> {
    return Promise.resolve({ ok: false, error: NOT_CONNECTED })
  }

  onArtifacts(cb: (thread: string) => void): () => void {
    this.artifactListeners.add(cb)
    return () => this.artifactListeners.delete(cb)
  }

  activity(): readonly ActivityItem[] {
    return this.activityRows
  }

  watchActivity(): void {}

  onActivity(cb: () => void): () => void {
    this.activityListeners.add(cb)
    return () => this.activityListeners.delete(cb)
  }

  /** As if the host sent its activity list. */
  setActivity(items: readonly ActivityItem[]): void {
    this.activityRows = items
    for (const cb of [...this.activityListeners]) cb()
  }

  /** As if the host sent `thread`'s snapshot. */
  setArtifacts(thread: string, snapshot: ArtifactsSnapshot): void {
    this.artifactMap.set(thread, snapshot)
    for (const cb of [...this.artifactListeners]) cb(thread)
  }

  /** There is no socket to carry a command. */
  command(): Promise<void> {
    return Promise.reject(new RelayCommandError('not_connected', NOT_CONNECTED))
  }

  /** Connected with these sessions, or disconnected (null). */
  set(sessions: readonly RelaySession[] | null): void {
    this.list = sessions === null ? null : new Map(sessions.map((s) => [s.id, s]))
    for (const cb of this.listeners) cb()
  }
}
