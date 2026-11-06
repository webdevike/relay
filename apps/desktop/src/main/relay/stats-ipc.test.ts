import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) =>
      ipc.handlers.set(channel, fn),
  },
  BaseWindow: class {},
  WebContentsView: class {},
}))
vi.mock('../window', () => ({ isAppUrl: () => true }))

import type { StatsSnapshot } from '@evaos/contract'
import type { MainContext } from '../context'
import type { RelayFeatures, RelayFrames, RelaySource } from './client'
import type { RelaySession } from './feed'
import { NO_HOST, OLD_HOST, registerStatsIpc } from './stats-ipc'

type Frame = Record<string, unknown>

const SNAPSHOT: StatsSnapshot = {
  updatedAt: 1793800000000,
  refreshing: false,
  profiles: [{ name: 'personal', error: null }],
  ranges: null,
}

/** A host that answers `stats.get` with SNAPSHOT when it has the feature. */
class FakeRelay implements RelaySource, RelayFrames, RelayFeatures {
  connected = false
  features: string[] = []
  sentFrames: Frame[] = []
  private frames = new Set<(f: Frame) => void>()
  private changes = new Set<() => void>()
  sessions = () => (this.connected ? new Map<string, RelaySession>() : null)
  hostHas = (feature: string) => this.connected && this.features.includes(feature)
  onChange(cb: () => void) {
    this.changes.add(cb)
    return () => this.changes.delete(cb)
  }
  onFrame(cb: (f: Frame) => void) {
    this.frames.add(cb)
    return () => this.frames.delete(cb)
  }
  sendFrame(frame: Frame): boolean {
    if (!this.connected) return false
    this.sentFrames.push(frame)
    if (frame.t === 'stats.get') queueMicrotask(() => this.push(SNAPSHOT))
    return true
  }
  push(stats: unknown): void {
    for (const cb of this.frames) cb({ t: 'stats.snapshot', stats })
  }
  connect(features: string[]): void {
    this.connected = true
    this.features = features
    for (const cb of this.changes) cb()
  }
}

describe('stats IPC', () => {
  const sent: Array<[string, unknown]> = []
  const ctx = {
    shell: {
      webContents: { isDestroyed: () => false, send: (c: string, p: unknown) => sent.push([c, p]) },
    },
  } as unknown as MainContext
  const call = (input: unknown): Promise<unknown> =>
    ipc.handlers.get('stats.get')!({ senderFrame: { url: 'app://shell' } }, input)
  beforeEach(() => {
    ipc.handlers.clear()
    sent.length = 0
  })

  it('says why there are no stats without a host or with one too old, and never asks it', async () => {
    const relay = new FakeRelay()
    registerStatsIpc(ctx, relay)
    expect(await call({})).toEqual({ ok: true, value: { stats: null, unavailable: NO_HOST } })
    relay.connected = true
    expect(await call({})).toEqual({ ok: true, value: { stats: null, unavailable: OLD_HOST } })
    expect(relay.sentFrames).toEqual([])
  })

  it('asks a host that has stats, relays its pushed snapshots, and tells the page when it comes up', async () => {
    const relay = new FakeRelay()
    registerStatsIpc(ctx, relay)
    relay.connect(['stats'])
    // Coming up: the page should ask again.
    expect(sent).toEqual([['stats.changed', { stats: null, unavailable: null }]])
    expect(await call({})).toEqual({ ok: true, value: { stats: SNAPSHOT, unavailable: null } })
    expect(relay.sentFrames).toEqual([{ t: 'stats.get' }])
    sent.length = 0
    const refreshing = { ...SNAPSHOT, refreshing: true }
    relay.push(refreshing)
    relay.push({ broken: true })
    expect(sent).toEqual([['stats.changed', { stats: refreshing, unavailable: null }]])
  })
})
