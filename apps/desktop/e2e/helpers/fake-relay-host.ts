// A stand-in for the local Relay host (relay apps/linux src/session.ts) on a real WebSocket, so e2e
// drives the app's actual Relay client: serve.json gives the port, devices.json the paired secret
// (the app adds its own), the handshake checks the HMAC proof, and the agent frames follow
// relay packages/protocol/src/index.ts. Tests list sessions, stream replies, raise asks and
// approvals, and read every command the app sent. No WebSocket library: the few frame types Relay
// uses are framed here (RFC 6455, text, ping, close).
import { createHash, createHmac, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as path from 'node:path'
import type { Duplex } from 'node:stream'
import { z } from 'zod'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

type Json = Record<string, unknown>
const JsonSchema = z.record(z.string(), z.unknown())
const DevicesSchema = z.record(z.string(), z.object({ secretHex: z.string() }).partial())

export interface HostSession {
  id: string
  status: 'working' | 'waiting' | 'needs_permission' | 'idle' | 'ended'
  statusDetail?: string
  canRespond?: boolean
  kind?: 'manual' | 'job' | 'assistant'
  /** The registry agent an `assistant` thread belongs to. */
  assistant?: string
  title?: string
}

/** A command the app sent, with the session's status as the host had it when it arrived. */
export interface Received {
  id: string
  cmd: Json
  status: HostSession['status'] | null
}

class Peer {
  buffer = Buffer.alloc(0)
  nonce = ''
  /** The device id its `hello` named; `device` once its proof checked out. */
  hello = ''
  device: string | null = null
  subs = new Set<string>()
  constructor(readonly socket: Duplex) {}

  send(frame: Json): void {
    const body = Buffer.from(JSON.stringify(frame))
    const head =
      body.length < 126
        ? Buffer.from([0x81, body.length])
        : body.length < 65_536
          ? Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff])
          : Buffer.concat([Buffer.from([0x81, 127]), u64(body.length)])
    this.socket.write(Buffer.concat([head, body]))
  }
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64BE(BigInt(n))
  return b
}

export class FakeRelayHost {
  /** Every command, in arrival order. */
  readonly commands: Received[] = []
  /** The next command is refused with this AckError. */
  nackNext: { code: string; message: string } | null = null
  private readonly peers = new Set<Peer>()
  private readonly sessions = new Map<string, HostSession>()
  private readonly asks = new Map<string, Json>()
  private readonly approvals = new Map<string, Json>()
  /** Each thread's reactions by reaction key, as the host keeps them. */
  private readonly reactionsOf = new Map<string, Record<string, Json>>()
  /** Every `reactions.get`, `reaction.set` and `reaction.clear` the app sent, in order. */
  readonly reactionFrames: Json[] = []
  private rev = 0

  private constructor(
    readonly dir: string,
    private readonly server: http.Server,
  ) {}

  /** Listens on a free port and writes `<dir>/serve.json` like the real host. */
  static async start(dir: string): Promise<FakeRelayHost> {
    fs.mkdirSync(dir, { recursive: true })
    const server = http.createServer((_req, res) => res.writeHead(404).end())
    const host = new FakeRelayHost(dir, server)
    server.on('upgrade', (req, socket) => host.upgrade(req, socket))
    const { promise, resolve } = Promise.withResolvers<void>()
    server.listen(0, '127.0.0.1', resolve)
    await promise
    // Listening on a TCP port, so the address is an AddressInfo (a string only for pipes).
    const address = server.address() as AddressInfo
    const { port } = address
    fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify({ port, pid: process.pid }))
    return host
  }

  async close(): Promise<void> {
    for (const p of this.peers) p.socket.destroy()
    const { promise, resolve } = Promise.withResolvers<void>()
    this.server.close(() => resolve())
    await promise
  }

  /** Lists (or updates) sessions, as an `agents.delta`. */
  upsert(...sessions: HostSession[]): void {
    for (const s of sessions) this.sessions.set(s.id, { ...this.sessions.get(s.id), ...s })
    this.rev += 1
    this.broadcast({
      t: 'agents.delta',
      rev: this.rev,
      upsert: sessions.map((s) => this.wire(s.id)),
    })
  }

  /** The app is subscribed to this session's stream. */
  subscribed(sessionId: string): boolean {
    return [...this.peers].some((p) => p.subs.has(sessionId))
  }

  /** The text so far of a reply the session streams. */
  stream(sessionId: string, id: string, text: string, streaming: boolean): void {
    this.toSubscribers(sessionId, { t: 'agent.message.update', sessionId, id, text, streaming })
  }

  ask(sessionId: string, ask: Json): void {
    this.asks.set(sessionId, ask)
    this.toSubscribers(sessionId, { t: 'agent.ask', sessionId, ask })
  }

  approval(sessionId: string, approval: Json): void {
    this.approvals.set(sessionId, approval)
    this.toSubscribers(sessionId, { t: 'agent.approval', sessionId, approval })
  }

  /**
   * The replies the app sent, and how omp's bridge takes each: `sendUserMessage` prompts an idle
   * session and steers one that is replying (relay-bridge.ts, `case "reply"`).
   */
  replies(): Array<{ session: string; text: string; mode: 'prompt' | 'steer'; images: number }> {
    return this.commands
      .filter((c) => c.cmd.kind === 'agent.reply')
      .map((c) => ({
        session: String(c.cmd.sessionId),
        text: String(c.cmd.text),
        mode: c.status === 'working' ? 'steer' : 'prompt',
        images: Array.isArray(c.cmd.images) ? c.cmd.images.length : 0,
      }))
  }

  kinds(): string[] {
    return this.commands.map((c) => String(c.cmd.kind))
  }

  /**
   * Sets a thread's reactions, by reaction key then reactor (`isaac` or an assistant's id), as the
   * phone or an assistant would, and pushes its snapshot to every device.
   */
  setReactions(thread: string, reactions: Record<string, Json>): void {
    this.reactionsOf.set(thread, reactions)
    this.broadcast(this.snapshotOf(thread))
  }

  private snapshotOf(thread: string): Json {
    return { t: 'reactions.snapshot', thread, reactions: this.reactionsOf.get(thread) ?? {} }
  }

  private wire(id: string): Json {
    const s = this.sessions.get(id)!
    return {
      id,
      provider: 'omp',
      // Like omp's bridge: an unnamed session goes by its folder's name.
      title: s.title ?? 'eva-root',
      projectPath: '/fixture/eva-root',
      status: s.status,
      ...(s.statusDetail ? { statusDetail: s.statusDetail } : {}),
      lastActivity: '',
      lastActivityAt: Date.now(),
      canRespond: s.canRespond ?? true,
      kind: s.kind ?? 'manual',
      ...(s.assistant ? { assistant: s.assistant } : {}),
    }
  }

  private broadcast(frame: Json): void {
    for (const p of this.peers) if (p.device) p.send(frame)
  }

  private toSubscribers(sessionId: string, frame: Json): void {
    for (const p of this.peers) if (p.subs.has(sessionId)) p.send(frame)
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex): void {
    const key = req.headers['sec-websocket-key']
    if (req.url !== '/relay' || typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const peer = new Peer(socket)
    this.peers.add(peer)
    socket.on('data', (chunk: Buffer) => this.read(peer, chunk))
    socket.on('close', () => this.peers.delete(peer))
    socket.on('error', () => this.peers.delete(peer))
  }

  /** Unmasks every whole client frame in the buffer. */
  private read(peer: Peer, chunk: Buffer): void {
    peer.buffer = Buffer.concat([peer.buffer, chunk])
    for (;;) {
      const b = peer.buffer
      if (b.length < 2) return
      const opcode = b[0]! & 0x0f
      let len = b[1]! & 0x7f
      let at = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2)
        at = 4
      } else if (len === 127) {
        if (b.length < 10) return
        len = Number(b.readBigUInt64BE(2))
        at = 10
      }
      if (b.length < at + 4 + len) return
      const mask = b.subarray(at, at + 4)
      const body = Buffer.from(b.subarray(at + 4, at + 4 + len))
      for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!
      peer.buffer = b.subarray(at + 4 + len)
      if (opcode === 0x1) this.receive(peer, JsonSchema.parse(JSON.parse(body.toString('utf8'))))
      else if (opcode === 0x8) peer.socket.end(Buffer.from([0x88, 0]))
      else if (opcode === 0x9)
        peer.socket.write(Buffer.concat([Buffer.from([0x8a, body.length]), body]))
    }
  }

  private receive(peer: Peer, f: Json): void {
    switch (f.t) {
      case 'hello':
        peer.nonce = randomBytes(16).toString('hex')
        peer.device = null
        peer.send({ t: 'challenge', nonce: peer.nonce })
        peer.hello = String(f.deviceId)
        return
      case 'auth': {
        const id = peer.hello
        const secret = this.secretOf(id)
        if (secret === null) return peer.send({ t: 'unpaired' })
        const proof = createHmac('sha256', secret).update(peer.nonce).digest('hex')
        if (proof !== f.proof)
          return peer.send({ t: 'error', code: 'auth_failed', message: 'bad proof' })
        peer.device = id
        peer.send({
          t: 'welcome',
          state: {
            mac: {
              name: 'Fake Mac',
              version: '0',
              accessibilityGranted: false,
              agentsAvailable: true,
            },
            agents: { rev: this.rev, sessions: [...this.sessions.keys()].map((s) => this.wire(s)) },
          },
        })
        return
      }
      case 'ping':
        return peer.send({ t: 'pong', ts: f.ts, serverTs: Date.now() })
      case 'agents.get':
        return peer.send({
          t: 'agents.snapshot',
          rev: this.rev,
          sessions: [...this.sessions.keys()].map((s) => this.wire(s)),
        })
      case 'reactions.get':
        this.reactionFrames.push(f)
        return peer.send(this.snapshotOf(String(f.thread)))
      case 'reaction.set':
      case 'reaction.clear': {
        // A client's frames are always Isaac's; an assistant's reactions stay.
        this.reactionFrames.push(f)
        const thread = String(f.thread)
        const message = String(f.message)
        const { [message]: bubble, ...rest } = this.reactionsOf.get(thread) ?? {}
        const { isaac: _old, ...others } = bubble ?? {}
        const mine =
          f.t === 'reaction.set'
            ? { ...others, isaac: { emoji: f.emoji, excerpt: f.excerpt, at: Date.now() } }
            : others
        return this.setReactions(
          thread,
          Object.keys(mine).length > 0 ? { ...rest, [message]: mine } : rest,
        )
      }
      case 'agent.subscribe': {
        const id = String(f.sessionId)
        peer.subs.add(id)
        peer.send({ t: 'agent.conversation', sessionId: id, rev: 0, messages: [] })
        // Like the host's replayPending: what the session is blocked on right now.
        const ask = this.asks.get(id)
        if (ask) peer.send({ t: 'agent.ask', sessionId: id, ask })
        const approval = this.approvals.get(id)
        if (approval) peer.send({ t: 'agent.approval', sessionId: id, approval })
        return
      }
      case 'agent.unsubscribe':
        peer.subs.delete(String(f.sessionId))
        return
      case 'cmd':
        return this.command(peer, String(f.id), JsonSchema.parse(f.cmd))
      default:
        return
    }
  }

  private command(peer: Peer, id: string, cmd: Json): void {
    const session = String(cmd.sessionId)
    this.commands.push({ id, cmd, status: this.sessions.get(session)?.status ?? null })
    const refused = this.nackNext
    if (refused) {
      this.nackNext = null
      return peer.send({ t: 'nack', id, error: refused })
    }
    peer.send({ t: 'ack', id })
    const ask = this.asks.get(session)
    if ((cmd.kind === 'agent.ask.answer' || cmd.kind === 'agent.ask.cancel') && ask) {
      this.asks.delete(session)
      this.toSubscribers(session, { t: 'agent.ask.resolved', sessionId: session, id: ask.id })
    }
    const approval = this.approvals.get(session)
    if ((cmd.kind === 'agent.approve' || cmd.kind === 'agent.deny') && approval) {
      this.approvals.delete(session)
      this.toSubscribers(session, {
        t: 'agent.approval.resolved',
        sessionId: session,
        id: approval.id,
      })
    }
  }

  /** The paired device's secret from `devices.json`, which the app writes for itself. */
  private secretOf(device: string): Buffer | null {
    try {
      const devices = DevicesSchema.parse(
        JSON.parse(fs.readFileSync(path.join(this.dir, 'devices.json'), 'utf8')),
      )
      const hex = devices[device]?.secretHex
      return hex ? Buffer.from(hex, 'hex') : null
    } catch {
      return null
    }
  }
}
