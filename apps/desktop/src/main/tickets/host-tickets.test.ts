import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TICKETS_FEATURE,
  TicketsBoard,
  TicketsStatus,
  type TicketBoardFacts,
} from '@relay/protocol'
import type { RelayFeatures, RelayFrames } from '../relay/client'
import { createHostTickets, type HostTickets } from './host-tickets'

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../../e2e/fixtures/tickets/board.json'), 'utf8'),
) as { rev: number; board: unknown; status: unknown }
const board = TicketsBoard.parse(fixture.board)
const status = TicketsStatus.parse(fixture.status)
type Frame = Record<string, unknown>

/** A Relay Host answering `tickets.req` from the fixture board. */
class FakeHost implements RelayFrames, RelayFeatures {
  connected = true
  features = [TICKETS_FEATURE]
  silent = false
  rev = fixture.rev
  sent: Frame[] = []
  private listeners = new Set<(f: Frame) => void>()
  private changes = new Set<() => void>()

  onFrame(cb: (f: Frame) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
  onChange(cb: () => void): () => void {
    this.changes.add(cb)
    return () => this.changes.delete(cb)
  }
  hostHas(feature: string): boolean {
    return this.connected && this.features.includes(feature)
  }
  sendFrame(frame: Frame): boolean {
    if (!this.connected) return false
    this.sent.push(frame)
    if (frame.t === 'tickets.req' && !this.silent) {
      const rid = frame.rid
      queueMicrotask(() =>
        this.push({ t: 'tickets.res', rid, ok: true, board, rev: this.rev, status }),
      )
    }
    return true
  }
  push(frame: Frame): void {
    for (const cb of [...this.listeners]) cb(frame)
  }
  drop(): void {
    this.connected = false
    for (const cb of [...this.changes]) cb()
  }
  reconnect(): void {
    this.connected = true
    this.push({ t: 'welcome', features: this.features })
  }
  ops(): unknown[] {
    return this.sent.filter((f) => f.t === 'tickets.req').map((f) => (f.op as Frame).kind)
  }
}

/** Lets queued answers and the promise chains after them run (microtasks only). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const bridges: HostTickets[] = []
function bridge(host: FakeHost, timeoutMs = 1000): HostTickets {
  const b = createHostTickets(host, () => timeoutMs)
  bridges.push(b)
  return b
}
afterEach(() => {
  for (const b of bridges.splice(0)) b.stop()
  vi.useRealTimers()
})

const upsert = (key: string, title: string): TicketBoardFacts => ({
  ...board.tickets[0]!,
  key,
  title,
})

describe('host tickets', () => {
  it('sends no frame to a host without the feature and answers why', async () => {
    const host = new FakeHost()
    host.features = []
    const b = bridge(host)
    expect(await b.board()).toMatchObject({ source: 'fallback', reason: 'oldHost' })
    expect(await b.req({ kind: 'sync' })).toMatchObject({ reason: 'oldHost' })
    expect(host.sent.filter((f) => String(f.t).startsWith('tickets.'))).toEqual([])
    host.connected = false
    expect(await b.board()).toMatchObject({ source: 'fallback', reason: 'disconnected' })
    expect(host.sent.filter((f) => String(f.t).startsWith('tickets.'))).toEqual([])
  })

  it('subscribes once, holds the snapshot and applies deltas', async () => {
    const host = new FakeHost()
    const b = bridge(host)
    const seen: Array<string[] | null> = []
    b.onChange((keys) => seen.push(keys))
    await settle()
    expect(host.ops()).toEqual(['subscribe'])
    expect(b.snapshot()?.rev).toBe(1)
    host.push({ t: 'tickets.snapshot', rev: 2, board, status })
    expect(b.snapshot()?.rev).toBe(2)
    host.push({
      t: 'tickets.delta',
      rev: 3,
      base: 2,
      upserts: [upsert('ENG-9003', 'New'), upsert('ENG-9001', 'Renamed')],
      tombstones: ['ENG-9002'],
    })
    const view = b.snapshot()!
    expect(view.rev).toBe(3)
    expect(view.board.tickets.map((t) => [t.key, t.title])).toEqual([
      ['ENG-9003', 'New'],
      ['ENG-9001', 'Renamed'],
    ])
    expect(seen.at(-1)).toEqual(['ENG-9003', 'ENG-9001', 'ENG-9002'])
    expect(await b.board()).toMatchObject({ ok: true, rev: 3 })
    expect(host.ops()).toEqual(['subscribe'])
  })

  it('asks for the board again when a delta skips a revision', async () => {
    const host = new FakeHost()
    const b = bridge(host)
    await settle()
    host.rev = 7
    host.push({ t: 'tickets.delta', rev: 6, base: 5, upserts: [], tombstones: [] })
    await settle()
    expect(host.ops()).toEqual(['subscribe', 'board'])
    expect(b.snapshot()?.rev).toBe(7)
  })

  it('subscribes again after a reconnect', async () => {
    const host = new FakeHost()
    const b = bridge(host)
    await settle()
    host.drop()
    expect(b.snapshot()).toBeNull()
    host.reconnect()
    await settle()
    expect(host.ops()).toEqual(['subscribe', 'subscribe'])
    expect(b.snapshot()?.rev).toBe(1)
  })

  it('answers disconnected when the host goes quiet or away', async () => {
    vi.useFakeTimers()
    const host = new FakeHost()
    host.silent = true
    const b = bridge(host, 50)
    const answer = b.req({ kind: 'sync' })
    await vi.advanceTimersByTimeAsync(60)
    expect(await answer).toMatchObject({ source: 'fallback', reason: 'disconnected' })
    host.connected = false
    expect(await b.board()).toMatchObject({ reason: 'disconnected' })
  })

  it('passes a gate refusal through and rejects a host error', async () => {
    const host = new FakeHost()
    host.silent = true
    const b = bridge(host)
    const refused = b.req({ kind: 'sync' })
    const failed = b.req({ kind: 'summary', key: 'ENG-9001' })
    const [r1, r2] = host.sent.slice(-2).map((f) => f.rid)
    host.push({
      t: 'tickets.res',
      rid: r1,
      ok: false,
      refused: { code: 'writesOff', message: 'Off' },
    })
    host.push({ t: 'tickets.res', rid: r2, ok: false, error: 'No key' })
    expect(await refused).toMatchObject({ ok: true, res: { refused: { code: 'writesOff' } } })
    await expect(failed).rejects.toThrow('No key')
  })
})
