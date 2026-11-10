import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Room } from '@evaos/contract'
import type { RelayFeatures, RelayFrames } from './client'
import type { RoomsService } from '../rooms/service'
import { startRoomsBridge, UPSERT_EVERY_MS } from './rooms-bridge'

class FakeHost implements RelayFrames, RelayFeatures {
  readonly sent: Record<string, unknown>[] = []
  features: string[] = []
  private readonly cbs = new Set<(f: Record<string, unknown>) => void>()
  onFrame(cb: (f: Record<string, unknown>) => void): () => void {
    this.cbs.add(cb)
    return () => this.cbs.delete(cb)
  }
  sendFrame(frame: Record<string, unknown>): boolean {
    this.sent.push(frame)
    return true
  }
  hostHas(feature: string): boolean {
    return this.features.includes(feature)
  }
  welcome(features: string[]): void {
    this.features = features
    this.push({ t: 'welcome', features })
  }
  push(frame: Record<string, unknown>): void {
    for (const cb of [...this.cbs]) cb(frame)
  }
}

// Only the fields the bridge reads; the rest of a Room passes through untouched.
const ROOM = { id: 'r1', title: 'Face', phase: 'open', startedAt: 1 } as unknown as Room

function setup() {
  const host = new FakeHost()
  const changes = new Set<(room: Room) => void>()
  const service = {
    list: vi.fn(() => [ROOM]),
    onChange: (cb: (room: Room) => void) => {
      changes.add(cb)
      return () => changes.delete(cb)
    },
    create: vi.fn(() => Promise.resolve({ roomId: 'r9' })),
    post: vi.fn(),
    react: vi.fn(),
    stop: vi.fn(() => Promise.resolve()),
    raise: vi.fn(() =>
      Promise.reject(Object.assign(new Error('Already at Max'), { code: 'max-effort' })),
    ),
    budget: vi.fn(() => Promise.resolve(9)),
    answer: vi.fn(),
    image: vi.fn(() => Promise.reject(new Error('boom'))),
  } satisfies RoomsService
  let clock = 10_000
  const bridge = startRoomsBridge({ client: host, service, now: () => clock })
  const change = (): void => {
    for (const cb of changes) cb(ROOM)
  }
  return { host, service, bridge, change, tick: (ms: number) => (clock += ms) }
}

const answered = async (host: FakeHost, rid: string): Promise<unknown> => {
  await vi.waitFor(() => {
    if (!host.sent.some((f) => f.t === 'rooms.res' && f.rid === rid)) throw new Error('no answer')
  })
  return host.sent.find((f) => f.t === 'rooms.res' && f.rid === rid)?.result
}

afterEach(() => {
  vi.useRealTimers()
})

describe('rooms bridge (desktop side)', () => {
  it('syncs only to a host that lists "rooms", on every welcome', () => {
    const { host, change } = setup()
    host.welcome(['control'])
    change()
    host.push({ t: 'rooms.cmd', rid: 'x', cmd: { op: 'stop', roomId: 'r1' } })
    expect(host.sent).toEqual([])
    host.welcome(['rooms'])
    host.welcome(['rooms'])
    expect(host.sent).toEqual([
      { t: 'rooms.sync', rooms: [ROOM] },
      { t: 'rooms.sync', rooms: [ROOM] },
    ])
  })

  it('sends a busy room at most once per interval, its last change included', () => {
    vi.useFakeTimers()
    const { host, change, tick } = setup()
    host.welcome(['rooms'])
    host.sent.length = 0
    change()
    change()
    change()
    expect(host.sent).toHaveLength(1)
    tick(UPSERT_EVERY_MS)
    vi.advanceTimersByTime(UPSERT_EVERY_MS)
    expect(host.sent).toEqual([
      { t: 'rooms.upsert', room: ROOM },
      { t: 'rooms.upsert', room: ROOM },
    ])
  })

  it('runs a command on the service and answers with its value or error code', async () => {
    const { host, service } = setup()
    host.welcome(['rooms'])
    host.push({ t: 'rooms.cmd', rid: 'a', cmd: { op: 'budget', roomId: 'r1', choice: 'continue' } })
    expect(await answered(host, 'a')).toEqual({ ok: true, value: 9 })
    expect(service.budget).toHaveBeenCalledWith('r1', 'continue')
    host.push({ t: 'rooms.cmd', rid: 'b', cmd: { op: 'raise', roomId: 'r1' } })
    expect(await answered(host, 'b')).toEqual({
      ok: false,
      code: 'max-effort',
      message: 'Already at Max',
    })
    host.push({
      t: 'rooms.cmd',
      rid: 'c',
      cmd: { op: 'image', roomId: 'r1', path: '/x.png', max: 512 },
    })
    expect(await answered(host, 'c')).toEqual({ ok: false, code: 'error', message: 'boom' })
    host.push({ t: 'rooms.cmd', rid: 'd', cmd: { op: 'post', roomId: 'r1', text: 'hi' } })
    expect(await answered(host, 'd')).toEqual({ ok: true })
    expect(service.post).toHaveBeenCalledWith('r1', 'hi')
  })
})
