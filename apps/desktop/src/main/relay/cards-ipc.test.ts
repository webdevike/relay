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

import type { MainContext } from '../context'
import type { RelayCards, RelaySource } from './client'
import type { RelaySession } from './feed'
import { registerCardsIpc } from './cards-ipc'

/** Relay as the cards IPC sees it. */
class FakeRelay implements RelaySource, RelayCards {
  up = true
  ids: string[] | null = null
  dismissed: unknown[][] = []
  private changes = new Set<() => void>()
  private heard = new Set<() => void>()
  sessions = () => new Map<string, RelaySession>()
  onChange(cb: () => void) {
    this.changes.add(cb)
    return () => this.changes.delete(cb)
  }
  cardsUp = () => this.up
  dismissedCards = () => this.ids
  dismissCard = (...args: unknown[]) => {
    this.dismissed.push(args)
    return this.up
  }
  onCards(cb: () => void) {
    this.heard.add(cb)
    return () => this.heard.delete(cb)
  }
  snapshot(ids: string[]): void {
    this.ids = ids
    for (const cb of this.heard) cb()
  }
  setUp(up: boolean): void {
    this.up = up
    for (const cb of this.changes) cb()
  }
}

describe('cards IPC', () => {
  const sent: Array<[string, unknown]> = []
  const ctx = {
    shell: {
      webContents: { isDestroyed: () => false, send: (c: string, p: unknown) => sent.push([c, p]) },
    },
  } as unknown as MainContext
  const call = (channel: string, input: unknown): Promise<unknown> =>
    ipc.handlers.get(channel)!({ senderFrame: { url: 'app://shell' } }, input)
  beforeEach(() => {
    ipc.handlers.clear()
    sent.length = 0
  })

  it("answers with the host's set, sends dismissals, and pushes snapshots and the connection", async () => {
    const relay = new FakeRelay()
    const off = registerCardsIpc(ctx, relay)
    expect(await call('cards.dismissed.get', {})).toEqual({
      ok: true,
      value: { up: true, ids: null },
    })
    relay.snapshot(['a', 'b#running'])
    expect(await call('cards.dismissed.get', {})).toEqual({
      ok: true,
      value: { up: true, ids: ['a', 'b#running'] },
    })
    expect(await call('cards.dismiss', { id: 'c', on: true })).toEqual({
      ok: true,
      value: { sent: true },
    })
    expect(relay.dismissed).toEqual([['c', true]])
    relay.setUp(false)
    expect(await call('cards.dismiss', { id: 'd', on: true })).toEqual({
      ok: true,
      value: { sent: false },
    })
    expect(sent).toEqual([
      ['cards.dismissed.changed', { up: true, ids: ['a', 'b#running'] }],
      ['cards.dismissed.changed', { up: false, ids: null }],
    ])
    expect(await call('cards.dismiss', { id: '', on: true })).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    })
    off()
    relay.snapshot(['z'])
    expect(sent).toHaveLength(2)
  })
})
