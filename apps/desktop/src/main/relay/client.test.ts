import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLOSED,
  NOT_CONNECTED,
  NOT_RUNNING,
  NO_ANSWER,
  RelayClient,
  RelayCommandError,
  StaticRelay,
  type Dial,
  type RelaySessionEvent,
  type SocketHandlers,
} from './client'
import { createConfigStore } from '../config-store'
import { parseRelayRemote } from '../env'
import {
  REMOTE_FILE,
  deviceSecret,
  relayConfigDir,
  remoteDeviceId,
  remoteSecretStore,
  servePort,
} from './device'
import { DEVICE_ID, proof } from './feed'

const dirs: string[] = []
function configDir(port: number | null): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'))
  dirs.push(d)
  if (port !== null) fs.writeFileSync(path.join(d, 'serve.json'), JSON.stringify({ port, pid: 1 }))
  return d
}
afterEach(() => {
  vi.useRealTimers()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A Relay on the other end of an injected socket. */
class FakeRelay {
  urls: string[] = []
  sent: Record<string, unknown>[][] = []
  handlers: SocketHandlers[] = []
  closes = 0
  refuse = false
  dial: Dial = async (url, on) => {
    this.urls.push(url)
    if (this.refuse) throw new Error('ECONNREFUSED')
    const frames: Record<string, unknown>[] = []
    this.sent.push(frames)
    this.handlers.push(on)
    return {
      send: (text) => void frames.push(JSON.parse(text) as Record<string, unknown>),
      close: () => void this.closes++,
    }
  }
  frames(): Record<string, unknown>[] {
    return this.sent.at(-1) ?? []
  }
  say(frame: unknown): void {
    this.handlers.at(-1)!.message(JSON.stringify(frame))
  }
}

const SECRET = Buffer.alloc(32, 9)
const relaySession = (id: string, status: string) => ({
  id,
  provider: 'omp',
  title: id,
  projectPath: '/Eva',
  status,
  lastActivity: '',
  lastActivityAt: 0,
  canRespond: true,
})

describe('RelayClient', () => {
  beforeEach(() => vi.useFakeTimers())

  function connected(relay = new FakeRelay(), dir = configDir(7817)) {
    const client = new RelayClient({ configDir: dir, dial: relay.dial, secret: () => SECRET })
    const changes = vi.fn()
    client.onChange(changes)
    return { client, relay, changes }
  }

  it('connects, pairs, and keeps the session list from welcome and deltas', async () => {
    const { client, relay, changes } = connected()
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(relay.urls).toEqual(['ws://127.0.0.1:7817/relay'])
    expect(relay.frames()).toEqual([
      { t: 'hello', v: 1, deviceId: DEVICE_ID, deviceName: 'Relay Desktop', platform: 'ios' },
    ])
    relay.say({ t: 'challenge', nonce: 'abc' })
    expect(relay.frames().at(-1)).toEqual({ t: 'auth', proof: proof(SECRET, 'abc') })
    expect(client.sessions()).toBeNull()
    relay.say({
      t: 'welcome',
      state: { agents: { rev: 1, sessions: [relaySession('a', 'working')] } },
    })
    expect([...client.sessions()!.keys()]).toEqual(['a'])
    expect(client.down()).toBeNull()
    expect(changes).toHaveBeenCalledTimes(1)
    relay.say({ t: 'agents.delta', rev: 2, upsert: [relaySession('b', 'needs_permission')] })
    expect(client.sessions()!.get('b')?.status).toBe('needs_permission')
    // A gap asks for the full list and keeps what it had.
    relay.say({ t: 'agents.delta', rev: 9, remove: ['a'] })
    expect(relay.frames().at(-1)).toEqual({ t: 'agents.get' })
    expect(client.sessions()!.size).toBe(2)
    client.stop()
  })

  it('pings every ten seconds once authenticated', async () => {
    const { client, relay } = connected()
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(relay.frames().filter((f) => f.t === 'ping')).toHaveLength(0)
    relay.say({ t: 'welcome', state: { agents: { rev: 0, sessions: [] } } })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(relay.frames().filter((f) => f.t === 'ping')).toHaveLength(2)
    client.stop()
  })

  it('is down while Relay is not running, and retries every three seconds', async () => {
    const dir = configDir(null)
    const { client, relay, changes } = connected(new FakeRelay(), dir)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect([client.sessions(), client.down()]).toEqual([null, NOT_RUNNING])
    expect(relay.urls).toEqual([])
    fs.writeFileSync(path.join(dir, 'serve.json'), JSON.stringify({ port: 9000 }))
    relay.refuse = true
    await vi.advanceTimersByTimeAsync(3000)
    expect(relay.urls).toEqual(['ws://127.0.0.1:9000/relay'])
    expect(client.down()).toBe(NOT_RUNNING)
    relay.refuse = false
    await vi.advanceTimersByTimeAsync(3000)
    relay.say({ t: 'welcome', state: { agents: { rev: 0, sessions: [] } } })
    expect(client.sessions()?.size).toBe(0)
    expect(changes).toHaveBeenCalledTimes(1)
    client.stop()
  })

  it('drops the list when the connection closes, then reconnects with a fresh handshake', async () => {
    const { client, relay, changes } = connected()
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    relay.say({
      t: 'welcome',
      state: { agents: { rev: 3, sessions: [relaySession('a', 'idle')] } },
    })
    relay.handlers.at(-1)!.closed(CLOSED)
    expect([client.sessions(), client.down()]).toEqual([null, CLOSED])
    expect(changes).toHaveBeenCalledTimes(2)
    // A late frame from the old socket changes nothing.
    relay.handlers[0]!.message(JSON.stringify({ t: 'agents.delta', rev: 4, upsert: [] }))
    expect(client.sessions()).toBeNull()
    await vi.advanceTimersByTimeAsync(3000)
    expect(relay.urls).toHaveLength(2)
    expect(relay.frames()[0]?.t).toBe('hello')
    // Rev starts over on the new connection.
    relay.say({ t: 'welcome', state: { agents: { rev: 1, sessions: [] } } })
    relay.say({ t: 'agents.delta', rev: 2, upsert: [relaySession('n', 'waiting')] })
    expect([...client.sessions()!.keys()]).toEqual(['n'])
    client.stop()
  })

  it('keeps the boards Relay streams and drops them with the connection', async () => {
    const { client, relay } = connected()
    const boardChanges = vi.fn()
    client.onBoardsChange(boardChanges)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    relay.say({ t: 'welcome', state: { agents: { rev: 0, sessions: [] } } })
    expect(relay.frames().filter((f) => f.t === 'board.subscribe')).toHaveLength(1)
    expect(client.boards()).toBeNull()
    const board = { slug: 'ops', title: 'Ops', widgets: [], updatedAt: '' }
    relay.say({ t: 'board.snapshot', rev: 1, boards: [board] })
    expect(client.boards()?.map((b) => b.slug)).toEqual(['ops'])
    relay.say({ t: 'board.delta', rev: 2, board: { ...board, title: 'Ops live' } })
    expect(client.boards()?.map((b) => b.title)).toEqual(['Ops live'])
    expect(boardChanges).toHaveBeenCalledTimes(2)
    relay.handlers.at(-1)!.closed(CLOSED)
    expect(client.boards()).toBeNull()
    expect(boardChanges).toHaveBeenCalledTimes(3)
    client.stop()
  })

  it('keeps the canvas rooms, opens a room once per slug and reuses its access', async () => {
    const { client, relay } = connected()
    const roomChanges = vi.fn()
    client.onCanvasRoomsChange(roomChanges)
    expect(await client.openCanvas('mind-map')).toEqual({ ok: false, error: NOT_CONNECTED })
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    relay.say({ t: 'welcome', state: { agents: { rev: 0, sessions: [] } } })
    expect(relay.frames().filter((f) => f.t === 'canvas.get')).toHaveLength(1)
    expect(client.canvasOrigin()).toBe('http://127.0.0.1:7817')
    const room = {
      id: 'r1',
      slug: 'mind-map',
      board: 'Mind map',
      live: true,
      agent: { name: 'Nova', color: '#7c5cff' },
      chat: {},
      humans: [],
      startedAt: 1,
    }
    relay.say({ t: 'canvas.rooms', rev: 1, rooms: [room] })
    expect(client.canvasRooms()?.map((r) => r.id)).toEqual(['r1'])
    // Two opens while the first is out ask once and get the same answer.
    const a = client.openCanvas('mind-map')
    const b = client.openCanvas('mind-map')
    expect(relay.frames().filter((f) => f.t === 'canvas.open')).toEqual([
      { t: 'canvas.open', slug: 'mind-map' },
    ])
    const access = { path: '/canvas/mind-map/?token=t', expiresAt: Date.now() + 3_600_000 }
    relay.say({ t: 'canvas.access', slug: 'mind-map', token: 't', ...access })
    expect(await a).toEqual({ ok: true, ...access })
    expect(await b).toEqual({ ok: true, ...access })
    // Still good: no new request.
    expect(await client.openCanvas('mind-map')).toEqual({ ok: true, ...access })
    expect(relay.frames().filter((f) => f.t === 'canvas.open')).toHaveLength(1)
    // The room ended: its access goes, and the host says why.
    relay.say({ t: 'canvas.rooms', rev: 2, rooms: [{ ...room, live: false, endedAt: 2 }] })
    const c = client.openCanvas('mind-map')
    relay.say({ t: 'canvas.unavailable', slug: 'mind-map', reason: 'The canvas session ended.' })
    expect(await c).toEqual({ ok: false, error: 'The canvas session ended.' })
    // Unanswered: it gives up.
    const d = client.openCanvas('other')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await d).toEqual({ ok: false, error: NO_ANSWER })
    // Dropped with the connection, and an open in flight fails with it.
    const e = client.openCanvas('mind-map')
    relay.handlers.at(-1)!.closed(CLOSED)
    expect(await e).toEqual({ ok: false, error: CLOSED })
    expect(client.canvasRooms()).toBeNull()
    expect(roomChanges).toHaveBeenCalledTimes(3)
    client.stop()
  })

  it('a refusal closes the socket, says why and retries', async () => {
    const { client, relay } = connected()
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    relay.say({ t: 'unpaired' })
    expect(relay.closes).toBe(1)
    expect(client.down()).toBe("Relay doesn't list this app as a paired device.")
    await vi.advanceTimersByTimeAsync(3000)
    expect(relay.urls).toHaveLength(2)
    client.stop()
    expect(relay.closes).toBe(2)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(relay.urls).toHaveLength(2)
  })

  it('a pairing failure is reported without overwriting anything', async () => {
    const relay = new FakeRelay()
    const client = new RelayClient({
      configDir: configDir(7817),
      dial: relay.dial,
      secret: () => {
        throw new Error('devices.json is not JSON')
      },
    })
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(client.down()).toBe("Couldn't add this app to Relay's devices: devices.json is not JSON")
    expect(relay.closes).toBe(1)
    client.stop()
  })

  async function welcomed() {
    const { client, relay, changes } = connected()
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    relay.say({
      t: 'welcome',
      state: { agents: { rev: 1, sessions: [relaySession('a', 'idle')] } },
    })
    return { client, relay, changes }
  }

  it('subscribes on every connection, and unsubscribes', async () => {
    const { client, relay } = connected()
    // Asked for before Relay is up: sent once it is.
    client.subscribe('a')
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(relay.frames().filter((f) => f.t === 'agent.subscribe')).toEqual([])
    relay.say({ t: 'welcome', state: { agents: { rev: 1, sessions: [] } } })
    client.subscribe('b')
    client.subscribe('b')
    expect(relay.frames().filter((f) => f.t === 'agent.subscribe')).toEqual([
      { t: 'agent.subscribe', sessionId: 'a' },
      { t: 'agent.subscribe', sessionId: 'b' },
    ])
    client.unsubscribe('a')
    expect(relay.frames().at(-1)).toEqual({ t: 'agent.unsubscribe', sessionId: 'a' })
    relay.handlers.at(-1)!.closed(CLOSED)
    await vi.advanceTimersByTimeAsync(3000)
    relay.say({ t: 'welcome', state: { agents: { rev: 1, sessions: [] } } })
    expect(relay.frames().filter((f) => f.t === 'agent.subscribe')).toEqual([
      { t: 'agent.subscribe', sessionId: 'b' },
    ])
    client.stop()
  })

  it('a command resolves on its ack and rejects on its nack with Relay error', async () => {
    const { client, relay } = await welcomed()
    const ok = client.command({ kind: 'agent.abort', sessionId: 'a' })
    const sent = relay.frames().at(-1)!
    expect(sent).toMatchObject({ t: 'cmd', cmd: { kind: 'agent.abort', sessionId: 'a' } })
    expect(String(sent.id)).toMatch(/^relay-desktop-\d+-1$/)
    const refused = client.command({ kind: 'agent.abort', sessionId: 'gone' })
    const second = relay.frames().at(-1)!
    expect(second.id).not.toBe(sent.id)
    relay.say({ t: 'ack', id: sent.id })
    await expect(ok).resolves.toBeUndefined()
    relay.say({
      t: 'nack',
      id: second.id,
      error: { code: 'agent_not_found', message: 'no session gone' },
    })
    await expect(refused).rejects.toEqual(
      new RelayCommandError('agent_not_found', 'no session gone'),
    )
    await expect(refused).rejects.toMatchObject({ code: 'agent_not_found' })
    client.stop()
  })

  it('a command fails at once while Relay is down, when the connection drops, or unanswered', async () => {
    const { client, relay } = connected()
    await expect(client.command({ kind: 'agent.abort', sessionId: 'a' })).rejects.toMatchObject({
      code: 'not_connected',
      message: NOT_CONNECTED,
    })
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    relay.say({ t: 'welcome', state: { agents: { rev: 1, sessions: [] } } })
    const dropped = client.command({ kind: 'agent.abort', sessionId: 'a' })
    relay.handlers.at(-1)!.closed(CLOSED)
    await expect(dropped).rejects.toMatchObject({ code: 'not_connected', message: CLOSED })
    await vi.advanceTimersByTimeAsync(3000)
    relay.say({ t: 'welcome', state: { agents: { rev: 1, sessions: [] } } })
    const silent = client.command({ kind: 'agent.abort', sessionId: 'a' })
    const check = expect(silent).rejects.toMatchObject({ code: 'timeout', message: NO_ANSWER })
    await vi.advanceTimersByTimeAsync(20_000)
    await check
    client.stop()
  })

  it("passes a subscribed session's stream, asks and approvals on", async () => {
    const { client, relay } = await welcomed()
    const events: RelaySessionEvent[] = []
    client.onEvent((e) => events.push(e))
    relay.say({ t: 'agent.message.update', sessionId: 'a', id: 'm', text: 'Hi', streaming: true })
    relay.say({ t: 'agent.approval.resolved', sessionId: 'a', id: 'c' })
    // Acks for commands it did not send are nobody's business.
    relay.say({ t: 'ack', id: 'unknown' })
    expect(events).toEqual([
      { kind: 'stream', session: 'a', id: 'm', text: 'Hi', streaming: true },
      { kind: 'approvalResolved', session: 'a', id: 'c' },
    ])
    client.stop()
  })

  it('asks for watched threads on every connection, keeps their snapshots and sends reactions', async () => {
    const { client, relay, changes } = connected()
    const heard = vi.fn()
    client.onReactions(heard)
    // Watched before Relay is up: nothing goes out, nothing can be sent.
    client.watchReactions('session:a')
    expect(client.reactionsUp()).toBe(false)
    expect(client.react('session:a', 'user@1', '👍', 'hi')).toBe(false)
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(relay.frames().filter((f) => f.t === 'reactions.get')).toEqual([])
    relay.say({ t: 'welcome', state: { agents: { rev: 1, sessions: [] } } })
    expect(client.reactionsUp()).toBe(true)
    expect(changes).toHaveBeenCalledTimes(1)
    client.watchReactions('assistant:astra')
    expect(relay.frames().filter((f) => f.t === 'reactions.get')).toEqual([
      { t: 'reactions.get', thread: 'session:a' },
      { t: 'reactions.get', thread: 'assistant:astra' },
    ])

    // Plain frames, no cmd and no ack.
    expect(client.react('session:a', 'assistant@5', '❤️', 'Done.')).toBe(true)
    expect(relay.frames().at(-1)).toEqual({
      t: 'reaction.set',
      thread: 'session:a',
      message: 'assistant@5',
      emoji: '❤️',
      excerpt: 'Done.',
    })
    client.react('session:a', 'assistant@5', null, 'Done.')
    expect(relay.frames().at(-1)).toEqual({
      t: 'reaction.clear',
      thread: 'session:a',
      message: 'assistant@5',
    })

    const reaction = { isaac: { emoji: '❤️', excerpt: 'Done.', at: 9 } }
    relay.say({
      t: 'reactions.snapshot',
      thread: 'session:a',
      reactions: { 'assistant@5': reaction },
    })
    // A thread no chat shows is not kept.
    relay.say({ t: 'reactions.snapshot', thread: 'session:zz', reactions: {} })
    expect(heard.mock.calls).toEqual([['session:a']])
    expect(client.reactions('session:a')).toEqual({ 'assistant@5': reaction })
    expect(client.reactions('session:zz')).toEqual({})

    // Down: the last snapshot stays, sending does not. Back up: asked again.
    relay.handlers.at(-1)!.closed(CLOSED)
    expect(client.reactionsUp()).toBe(false)
    expect(client.reactions('session:a')).toEqual({ 'assistant@5': reaction })
    client.unwatchReactions('assistant:astra')
    await vi.advanceTimersByTimeAsync(3000)
    relay.say({ t: 'welcome', state: { agents: { rev: 1, sessions: [] } } })
    expect(relay.frames().filter((f) => f.t === 'reactions.get')).toEqual([
      { t: 'reactions.get', thread: 'session:a' },
    ])
    client.stop()
  })
})

describe('StaticRelay', () => {
  it('stays disconnected until a test sets sessions', () => {
    const relay = new StaticRelay()
    const changes = vi.fn()
    relay.onChange(changes)
    expect(relay.sessions()).toBeNull()
    relay.set([
      {
        id: 'a',
        status: 'idle',
        detail: null,
        canRespond: true,
        kind: 'manual',
        title: '',
        assistant: null,
      },
    ])
    expect([...relay.sessions()!.keys()]).toEqual(['a'])
    relay.set(null)
    expect(relay.sessions()).toBeNull()
    expect(changes).toHaveBeenCalledTimes(2)
  })

  it('never sends or hears reactions', () => {
    const relay = new StaticRelay()
    relay.set([])
    relay.watchReactions()
    expect(relay.reactionsUp()).toBe(false)
    expect(relay.react()).toBe(false)
    expect(relay.reactions()).toEqual({})
  })
})

describe('Relay device files', () => {
  it('finds the config folder through XDG_CONFIG_HOME, else ~/.config', () => {
    expect(relayConfigDir({ XDG_CONFIG_HOME: '/x' }, '/home/i')).toBe('/x/relay')
    expect(relayConfigDir({ XDG_CONFIG_HOME: '' }, '/home/i')).toBe('/home/i/.config/relay')
  })

  it('reads the port from serve.json, null when absent or bad', () => {
    expect(servePort(configDir(7817))).toBe(7817)
    expect(servePort(configDir(null))).toBeNull()
    const bad = configDir(null)
    fs.writeFileSync(path.join(bad, 'serve.json'), '{"port":"x"}')
    expect(servePort(bad)).toBeNull()
  })

  it('adds itself to devices.json once, owner-only, keeping the phones', () => {
    const dir = configDir(null)
    const file = path.join(dir, 'devices.json')
    const phone = { secretHex: 'ab'.repeat(32), name: 'iPhone', pairedAt: 1 }
    fs.writeFileSync(file, JSON.stringify({ phone }))
    const secret = deviceSecret(dir, () => 42)
    expect(secret).toHaveLength(32)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(saved).toEqual({
      phone,
      [DEVICE_ID]: { secretHex: secret.toString('hex'), name: 'Relay Desktop', pairedAt: 42 },
    })
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(deviceSecret(dir)).toEqual(secret)
    expect(fs.readdirSync(dir)).toEqual(['devices.json'])
  })

  it('creates devices.json when there is none, and never overwrites one it cannot read', () => {
    const dir = path.join(configDir(null), 'nested')
    expect(deviceSecret(dir)).toHaveLength(32)
    const bad = configDir(null)
    fs.writeFileSync(path.join(bad, 'devices.json'), 'not json')
    expect(() => deviceSecret(bad)).toThrow()
    expect(fs.readFileSync(path.join(bad, 'devices.json'), 'utf8')).toBe('not json')
  })
})

describe('RelayClient with a remote host', () => {
  beforeEach(() => vi.useFakeTimers())

  function remote(stored: Uint8Array | null = null, pins: (string | null)[] = []) {
    const host = {
      host: '100.85.157.127',
      port: 7817,
      deviceId: 'relay-desktop-laptop',
      stored,
      asked: [] as boolean[],
      secret: () => host.stored,
      save: (s: Uint8Array) => void (host.stored = s),
      askPin: async (retry: boolean) => {
        host.asked.push(retry)
        return pins.shift() ?? null
      },
    }
    const relay = new FakeRelay()
    // No Relay folder: the local host's serve.json and devices.json are never read.
    const client = new RelayClient({
      configDir: null,
      remote: host,
      dial: relay.dial,
      secret: () => {
        throw new Error('local devices.json touched')
      },
      retryMs: 10,
    })
    return { client, relay, host }
  }

  it('dials the remote host and serves its canvas origin', async () => {
    const { client, relay } = remote()
    expect(client.canvasOrigin()).toBe('http://100.85.157.127:7817')
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(relay.urls).toEqual(['ws://100.85.157.127:7817/relay'])
    expect(relay.frames()[0]).toMatchObject({ t: 'hello', deviceId: 'relay-desktop-laptop' })
    expect(client.canvasOrigin()).toBe('http://100.85.157.127:7817')
    client.stop()
  })

  it('pairs with the PIN, keeps the secret, and authenticates without pairing next time', async () => {
    const { client, relay, host } = remote(null, ['111111', '123456'])
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    relay.say({ t: 'unpaired' })
    expect(relay.frames().at(-1)).toEqual({ t: 'pair.request' })
    relay.say({ t: 'pair.pending' })
    await vi.advanceTimersByTimeAsync(0)
    expect(relay.frames().at(-1)).toEqual({ t: 'pair.confirm', pin: '111111' })
    relay.say({ t: 'pair.failed', reason: 'wrong_pin' })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.asked).toEqual([false, true])
    expect(relay.frames().at(-1)).toEqual({ t: 'pair.confirm', pin: '123456' })
    const secret = Buffer.alloc(32, 5)
    relay.say({ t: 'pair.ok', secret: secret.toString('hex') })
    expect(Buffer.from(host.stored!)).toEqual(secret)
    relay.say({ t: 'welcome', state: { agents: { rev: 1, sessions: [relaySession('a', 'idle')] } } })
    expect([...client.sessions()!.keys()]).toEqual(['a'])

    // Sleep, restart or a host restart: the next connection answers the challenge, no PIN.
    relay.handlers.at(-1)!.closed(CLOSED)
    await vi.advanceTimersByTimeAsync(10)
    expect(relay.urls).toHaveLength(2)
    relay.say({ t: 'challenge', nonce: 'n2' })
    expect(relay.frames().at(-1)).toEqual({ t: 'auth', proof: proof(secret, 'n2') })
    expect(host.asked).toEqual([false, true])
    client.stop()
  })

  it('a cancelled PIN drops the connection and tries again', async () => {
    const { client, relay } = remote(null, [null])
    client.start()
    await vi.advanceTimersByTimeAsync(0)
    relay.say({ t: 'unpaired' })
    relay.say({ t: 'pair.pending' })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.down()).toBe('Pairing with Relay Host was cancelled.')
    expect(relay.closes).toBe(1)
    client.stop()
  })
})

describe('remote pairing config', () => {
  it('keeps the secret per host:port in app config, keeping the host setting', () => {
    const config = createConfigStore(configDir(null))
    config.writeJson(REMOTE_FILE, { host: '100.85.157.127:7817' })
    const store = remoteSecretStore(config, { host: '100.85.157.127', port: 7817 })
    expect(store.secret()).toBeNull()
    store.save(Buffer.alloc(32, 3))
    expect(config.readJson(REMOTE_FILE, {})).toEqual({
      host: '100.85.157.127:7817',
      paired: { id: '100.85.157.127:7817', secretHex: '03'.repeat(32) },
    })
    expect(Buffer.from(store.secret()!)).toEqual(Buffer.alloc(32, 3))
    // Another host is not paired by this one's secret.
    expect(remoteSecretStore(config, { host: 'mini', port: 7817 }).secret()).toBeNull()
    expect(remoteDeviceId('laptop')).toBe('relay-desktop-laptop')
  })

  it('parses host:port like the phone, and refuses anything else', () => {
    expect(parseRelayRemote(undefined)).toBeNull()
    expect(parseRelayRemote(' 100.85.157.127:7817 ')).toEqual({ host: '100.85.157.127', port: 7817 })
    expect(parseRelayRemote('[fd7a::1]:7817')).toEqual({ host: 'fd7a::1', port: 7817 })
    for (const bad of ['mini', 'mini:0', 'mini:70000', 7817]) {
      expect(() => parseRelayRemote(bad)).toThrow()
    }
  })
})
