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

import type { ThreadReactions } from '@evaos/chat-core/reactions'
import type { MainContext } from '../context'
import type { RelayReactions, RelaySource } from './client'
import type { RelaySession } from './feed'
import { reactionThreadOf, registerReactionsIpc } from './reactions-ipc'

const relaySession = (id: string, extra: Partial<RelaySession> = {}): RelaySession => ({
  id,
  status: 'idle',
  detail: null,
  canRespond: true,
  kind: 'manual',
  title: '',
  assistant: null,
  ...extra,
})
const FILE = '/s/-fixture/2026-10-05T10-00-00-000Z_s1.jsonl'

describe('reactionThreadOf', () => {
  it("is the agent's thread on its page, and for a session Relay lists as its thread", () => {
    expect(reactionThreadOf('', 'astra', null)).toBe('assistant:astra')
    expect(reactionThreadOf(FILE, 'astra', null)).toBe('assistant:astra')
    const sessions = new Map([['s1', relaySession('s1', { kind: 'assistant', assistant: 'nova' })]])
    expect(reactionThreadOf(FILE, null, sessions)).toBe('assistant:nova')
  })

  it("is the session's own otherwise, and null without a file or for a bad name", () => {
    expect(reactionThreadOf(FILE, null, null)).toBe('session:s1')
    expect(reactionThreadOf(FILE, null, new Map([['s1', relaySession('s1')]]))).toBe('session:s1')
    expect(reactionThreadOf('', null, null)).toBeNull()
    expect(reactionThreadOf('', 'Not An Id', null)).toBeNull()
  })
})

/** Relay as the reactions IPC sees it, connected or not. */
class FakeRelay implements RelaySource, RelayReactions {
  up = true
  snapshots = new Map<string, ThreadReactions>()
  watching: string[] = []
  sent: unknown[][] = []
  private changes = new Set<() => void>()
  private heard = new Set<(thread: string) => void>()
  sessions = () => new Map<string, RelaySession>()
  onChange(cb: () => void) {
    this.changes.add(cb)
    return () => this.changes.delete(cb)
  }
  reactionsUp = () => this.up
  reactions = (thread: string) => this.snapshots.get(thread) ?? {}
  watchReactions = (thread: string) => void this.watching.push(thread)
  unwatchReactions = (thread: string) => {
    this.watching = this.watching.filter((t) => t !== thread)
  }
  react = (...args: unknown[]) => {
    this.sent.push(args)
    return this.up
  }
  onReactions(cb: (thread: string) => void) {
    this.heard.add(cb)
    return () => this.heard.delete(cb)
  }
  snapshot(thread: string, reactions: ThreadReactions): void {
    this.snapshots.set(thread, reactions)
    for (const cb of this.heard) cb(thread)
  }
  setUp(up: boolean): void {
    this.up = up
    for (const cb of this.changes) cb()
  }
}

describe('reactions IPC', () => {
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

  it('watches a chat, pushes its snapshots and the connection, and sends reactions', async () => {
    const relay = new FakeRelay()
    const off = registerReactionsIpc(ctx, relay)
    const heart = { isaac: { emoji: '❤️', excerpt: 'Done.', at: 3 } }
    relay.snapshots.set('session:s1', { 'assistant@2': heart })
    expect(await call('reactions.watch', { file: FILE, agent: null })).toEqual({
      ok: true,
      value: { thread: 'session:s1', up: true, reactions: { 'assistant@2': heart } },
    })
    // A second view of the same thread keeps it watched until both let go.
    await call('reactions.watch', { file: FILE, agent: null })
    expect(relay.watching).toEqual(['session:s1', 'session:s1'])
    await call('reactions.unwatch', { thread: 'session:s1' })
    expect(relay.watching).toEqual(['session:s1', 'session:s1'])

    expect(
      await call('reactions.react', {
        thread: 'session:s1',
        message: 'assistant@2',
        emoji: '👍',
        excerpt: 'Done.',
      }),
    ).toEqual({ ok: true, value: { sent: true } })
    expect(relay.sent).toEqual([['session:s1', 'assistant@2', '👍', 'Done.']])
    // A thread no chat watches is never sent.
    expect(
      await call('reactions.react', {
        thread: 'session:zz',
        message: 'user@1',
        emoji: null,
        excerpt: '',
      }),
    ).toEqual({ ok: true, value: { sent: false } })
    expect(
      await call('reactions.react', {
        thread: 'session:s1',
        message: 'tool@1',
        emoji: '👍',
        excerpt: '',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })

    relay.snapshot('session:s1', {})
    relay.setUp(false)
    relay.setUp(false)
    expect(sent).toEqual([
      ['reactions.changed', { thread: 'session:s1', up: true, reactions: {} }],
      ['reactions.status', { up: false }],
    ])
    await call('reactions.unwatch', { thread: 'session:s1' })
    expect(relay.watching).toEqual([])
    off()
  })

  it('answers a chat without a session with no thread', async () => {
    registerReactionsIpc(ctx, new FakeRelay())
    expect(await call('reactions.watch', { file: '', agent: null })).toEqual({
      ok: true,
      value: { thread: null, up: true, reactions: {} },
    })
  })
})
