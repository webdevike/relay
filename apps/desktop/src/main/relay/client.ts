// The connection to Relay, kept up in the background and retried while Relay is down, ported from
// relay.rs (keep_connected, run_connection). One connection: read the port from serve.json, open
// ws://127.0.0.1:<port>/relay, pair through devices.json, say hello, answer the challenge, then
// keep the session list from `welcome`, `agents.snapshot` and `agents.delta` and the boards from
// `board.snapshot` and `board.delta`, pinging every 10 s (Relay drops a peer that is quiet for a
// minute). Any failure drops both lists and retries in 3 s.
//
// Subscriptions outlive a connection: each new one subscribes again (native `remember`). A command
// cannot wait for one: sent while Relay is down it fails at once, and one in flight when the
// connection drops fails with it.
import type { Board } from '@evaos/contract'
import {
  Feed,
  RelayRefused,
  hello,
  type FeedEvent,
  type FeedOutput,
  type RelaySession,
} from './feed'
import { cmdFrame, subscribeFrame, unsubscribeFrame, type RelayCommand } from './commands'
import { deviceSecret, servePort } from './device'

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
export type RelaySessionEvent = Exclude<FeedEvent, { kind: 'sessions' | 'ack' | 'nack' | 'boards' }>

/** Relay as the chat pane drives it: the session list, subscriptions and commands. */
export interface RelayLink extends RelaySource {
  /** Streams `sessionId`'s replies, asks and approvals, on this connection and every later one. */
  subscribe(sessionId: string): void
  unsubscribe(sessionId: string): void
  /** Resolves once Relay carried the command out; rejects with a RelayCommandError. */
  command(cmd: RelayCommand): Promise<void>
  onEvent(cb: (e: RelaySessionEvent) => void): () => void
  /** The host's dashboards by title while connected; null until Relay sends them and while down. */
  boards(): readonly Board[] | null
  /** Called after every change of the boards, including Relay going down. */
  onBoardsChange(cb: () => void): () => void
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
  /** Relay's config folder (`relayConfigDir`). */
  configDir: string
  dial?: Dial
  /** Test seam: this app's paired secret. */
  secret?: (configDir: string) => Uint8Array
  retryMs?: number
  pingMs?: number
  commandTimeoutMs?: number
  now?: () => number
}

interface Pending {
  resolve(): void
  reject(e: RelayCommandError): void
  timer: NodeJS.Timeout
}

/** Keeps a connection to Relay up while started; `sessions()` is null whenever it is down. */
export class RelayClient implements RelayLink {
  private readonly dial: Dial
  private readonly secret: (configDir: string) => Uint8Array
  private readonly retryMs: number
  private readonly pingMs: number
  private readonly commandTimeoutMs: number
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private readonly boardListeners = new Set<() => void>()
  private readonly eventListeners = new Set<(e: RelaySessionEvent) => void>()
  private readonly subscriptions = new Set<string>()
  /** Commands sent on this connection, by id, until Relay answers. */
  private readonly pending = new Map<string, Pending>()
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

  /** Why Relay is down, while it is (null before the first attempt ends and while connected). */
  down(): string | null {
    return this.reason
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
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

  command(cmd: RelayCommand): Promise<void> {
    if (!this.feed?.authenticated) {
      return Promise.reject(new RelayCommandError('not_connected', NOT_CONNECTED))
    }
    this.commands += 1
    const id = `relay-desktop-${this.now()}-${this.commands}`
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      this.pending.delete(id)
      reject(new RelayCommandError('timeout', NO_ANSWER))
    }, this.commandTimeoutMs)
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
  }

  private async connect(): Promise<void> {
    this.retryTimer = undefined
    const attempt = ++this.attempt
    const port = servePort(this.o.configDir)
    if (port === null) return this.fail(NOT_RUNNING)
    let socket: RelaySocket
    try {
      socket = await this.dial(`ws://127.0.0.1:${port}/relay`, {
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
    let secret: Uint8Array
    try {
      secret = this.secret(this.o.configDir)
    } catch (e) {
      socket.close()
      return this.fail(`Couldn't add this app to Relay's devices: ${(e as Error).message}`)
    }
    this.socket = socket
    this.feed = new Feed(secret)
    this.send(hello())
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
    }
    for (const event of out.events) {
      switch (event.kind) {
        case 'sessions':
          this.setList(new Map(event.sessions.map((s) => [s.id, s])))
          break
        case 'boards':
          this.setBoards(event.boards)
          break
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
        default:
          for (const cb of [...this.eventListeners]) cb(event)
      }
    }
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
}

/** A Relay that is never connected: fixtures and e2e, unless a test sets sessions. */
export class StaticRelay implements RelayLink {
  private list: ReadonlyMap<string, RelaySession> | null = null
  private readonly listeners = new Set<() => void>()

  sessions(): ReadonlyMap<string, RelaySession> | null {
    return this.list
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  onEvent(): () => void {
    return () => undefined
  }

  /** Never connected, so never any boards. */
  boards(): readonly Board[] | null {
    return null
  }

  onBoardsChange(): () => void {
    return () => undefined
  }

  subscribe(): void {}

  unsubscribe(): void {}

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
