import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLOSED,
  NOT_RUNNING,
  RelayClient,
  StaticRelay,
  type Dial,
  type SocketHandlers,
} from './client'
import { deviceSecret, relayConfigDir, servePort } from './device'
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
