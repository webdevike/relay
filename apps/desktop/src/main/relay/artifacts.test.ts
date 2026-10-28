import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
  opened: [] as string[],
}))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) =>
      ipc.handlers.set(channel, fn),
  },
  shell: { openExternal: async (url: string) => void ipc.opened.push(url) },
  BaseWindow: class {},
  WebContentsView: class {},
}))
vi.mock('../window', () => ({ isAppUrl: () => true }))

import type { Artifact, ArtifactAction } from '@evaos/chat-core/artifacts'
import type { LinearIssue } from '@evaos/contract'
import type { MainContext } from '../context'
import type { PrFacts } from '../context-popover/gh'
import { artifactsRunners, artifactsScope } from './artifacts-agent'
import { registerArtifactsIpc } from './artifacts-ipc'
import {
  STATUS_STALE_MS,
  linearStatus,
  prRef,
  prStatus,
  startStatusReader,
} from './artifacts-status'
import type { ArtifactsActed, ArtifactsSnapshot, RelayArtifacts, RelaySource } from './client'
import type { RelaySession } from './feed'

const item = (id: string, extra: Partial<Artifact> = {}): Artifact => ({
  id,
  kind: id.split(':')[0] as Artifact['kind'],
  title: id,
  mentions: 1,
  firstSeen: 1,
  lastSeen: Date.now(),
  sources: [],
  addedBy: 'extractor',
  ...extra,
})

class FakeRelay implements RelaySource, RelayArtifacts {
  up = true
  map = new Map<string, ArtifactsSnapshot>()
  watching: string[] = []
  acts: Array<{ thread: string; by: string; action: ArtifactAction }> = []
  answer: ArtifactsActed = { ok: true }
  list: ReadonlyMap<string, RelaySession> | null = new Map()
  private changes = new Set<() => void>()
  private heard = new Set<(thread: string) => void>()
  sessions = () => this.list
  onChange(cb: () => void) {
    this.changes.add(cb)
    return () => this.changes.delete(cb)
  }
  artifactsUp = () => this.up
  artifacts = (thread: string) => this.map.get(thread) ?? null
  artifactThreads = () => this.map
  watchArtifacts = (thread: string) => void this.watching.push(thread)
  unwatchArtifacts = (thread: string) => {
    this.watching = this.watching.filter((t) => t !== thread)
  }
  actArtifacts = async (thread: string, by: string, action: ArtifactAction) => {
    this.acts.push({ thread, by, action })
    return this.answer
  }
  onArtifacts(cb: (thread: string) => void) {
    this.heard.add(cb)
    return () => this.heard.delete(cb)
  }
  snapshot(thread: string, snap: ArtifactsSnapshot): void {
    this.map.set(thread, snap)
    for (const cb of [...this.heard]) cb(thread)
  }
  setUp(up: boolean): void {
    this.up = up
    for (const cb of this.changes) cb()
  }
}

const FILE = '/s/-fixture/2026-10-05T10-00-00-000Z_s1.jsonl'

const statusIds = (action: ArtifactAction): string[] =>
  action.op === 'status' ? Object.keys(action.statuses) : []

describe('artifacts IPC', () => {
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

  it("watches a thread while any panel shows it, and pushes that thread's snapshots", async () => {
    const relay = new FakeRelay()
    registerArtifactsIpc(ctx, relay)
    const a = item('url:https://a.dev')
    relay.map.set('assistant:astra', { items: [a], tabs: [] })
    expect(await call('artifacts.watch', { file: '', agent: 'astra' })).toEqual({
      ok: true,
      value: { thread: 'assistant:astra', up: true, loaded: true, items: [a], tabs: [] },
    })
    await call('artifacts.watch', { file: '', agent: 'astra' })
    expect(relay.watching).toEqual(['assistant:astra', 'assistant:astra'])
    relay.snapshot('assistant:nova', { items: [], tabs: [] })
    expect(sent).toEqual([])
    relay.snapshot('assistant:astra', { items: [], tabs: [] })
    expect(sent).toEqual([
      [
        'artifacts.changed',
        { thread: 'assistant:astra', up: true, loaded: true, items: [], tabs: [] },
      ],
    ])
    await call('artifacts.unwatch', { thread: 'assistant:astra' })
    expect(relay.watching).toHaveLength(2)
    await call('artifacts.unwatch', { thread: 'assistant:astra' })
    expect(relay.watching).toEqual([])
    relay.setUp(false)
    expect(sent.at(-1)).toEqual(['artifacts.status', { up: false }])
  })

  it('resolves a chat to its thread, none without a file, and acts as Isaac', async () => {
    const relay = new FakeRelay()
    registerArtifactsIpc(ctx, relay)
    expect(await call('artifacts.watch', { file: FILE, agent: null })).toMatchObject({
      value: { thread: 'session:s1', loaded: false },
    })
    expect(await call('artifacts.watch', { file: '', agent: null })).toMatchObject({
      value: { thread: null },
    })
    relay.answer = { ok: false, error: 'Defaults are hidden, not removed.' }
    expect(
      await call('artifacts.act', {
        thread: 'session:s1',
        action: { op: 'tab.remove', tab: 'links' },
      }),
    ).toEqual({
      ok: true,
      value: { ok: false, error: 'Defaults are hidden, not removed.' },
    })
    expect(relay.acts[0]).toEqual({
      thread: 'session:s1',
      by: 'isaac',
      action: { op: 'tab.remove', tab: 'links' },
    })
    await call('artifacts.openExternal', { url: 'https://linear.app/x' })
    expect(ipc.opened).toContain('https://linear.app/x')
  })
})

const PR: PrFacts = {
  repo: 'eCardSystems/reports',
  number: 241,
  title: 'Redesign the Reports listing',
  url: 'https://github.com/eCardSystems/reports/pull/241',
  state: 'OPEN',
  draft: true,
  decision: 'REVIEW_REQUIRED',
  base: 'develop',
  head: 'feat/eng-6525-reports-listing',
  additions: 1,
  deletions: 1,
  checks: { passed: 2, failed: 0, pending: 0, total: 2 },
  reviews: [],
}
const ISSUE: LinearIssue = {
  identifier: 'ENG-6528',
  title: 'eGift Order Hub is malformed',
  url: 'https://linear.app/ecard-systems/issue/ENG-6528',
  state: 'In QA',
  stateType: 'started',
  priority: 'High',
  assignee: 'Steve Arms',
  project: null,
  updatedAt: 1,
}

describe('live statuses', () => {
  it('maps a PR and a ticket to statuses', () => {
    expect(prRef('gh-pr:eCardSystems/reports#241')).toEqual({
      repo: 'eCardSystems/reports',
      number: 241,
    })
    expect(prRef('gh-issue:o/r#1')).toBeNull()
    expect(prStatus(PR, 5)).toEqual({
      state: 'open',
      title: 'Redesign the Reports listing',
      draft: true,
      checks: 'pass',
      review: 'required',
      linked: 'ENG-6525',
      fetchedAt: 5,
    })
    expect(
      prStatus(
        {
          ...PR,
          checks: { passed: 1, failed: 1, pending: 1, total: 3 },
          decision: null,
          head: 'x',
          title: 'y',
        },
        5,
      ),
    ).toMatchObject({
      checks: 'fail',
    })
    expect(
      prStatus({ ...PR, checks: { passed: 0, failed: 0, pending: 0, total: 0 } }, 5).checks,
    ).toBeUndefined()
    expect(linearStatus(ISSUE, 5)).toEqual({
      state: 'in qa',
      stateType: 'started',
      title: 'eGift Order Hub is malformed',
      assignee: 'Steve Arms',
      fetchedAt: 5,
    })
  })

  it('sends one batch per thread for stale items, and does not loop on its own snapshot', async () => {
    const relay = new FakeRelay()
    let prListener: () => void = () => undefined
    const prs = new Map<string, PrFacts>()
    const linear = vi.fn(async () => ISSUE)
    let now = 1_000_000
    const stop = startStatusReader({
      relay,
      pr: (repo, n) => prs.get(`${repo}#${n}`) ?? null,
      onPrChange: (cb) => {
        prListener = cb
        return () => undefined
      },
      linear,
      now: () => now,
    })
    const pr = item('gh-pr:eCardSystems/reports#241')
    const ticket = item('linear:ENG-6528')
    const fresh = item('linear:ENG-1', { status: { state: 'done', fetchedAt: now } })
    relay.snapshot('assistant:astra', { items: [pr, ticket, fresh], tabs: [] })
    await vi.waitFor(() => expect(relay.acts).toHaveLength(1))
    expect(relay.acts[0]!.by).toBe('relay-desktop')
    expect(statusIds(relay.acts[0]!.action)).toEqual(['linear:ENG-6528'])
    // The PR's facts arrive: the thread is told about the PR alone.
    prs.set('eCardSystems/reports#241', PR)
    prListener()
    await vi.waitFor(() => expect(relay.acts).toHaveLength(2))
    expect(statusIds(relay.acts[1]!.action)).toEqual([pr.id])
    // The host's answering snapshot (still without statuses, or with them) starts nothing new.
    relay.snapshot('assistant:astra', { items: [pr, ticket, fresh], tabs: [] })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(relay.acts).toHaveLength(2)
    expect(linear).toHaveBeenCalledTimes(1)
    now += STATUS_STALE_MS + 1
    relay.snapshot('assistant:astra', { items: [pr, ticket], tabs: [] })
    await vi.waitFor(() => expect(relay.acts).toHaveLength(3))
    stop()
  })
})

describe('artifacts agent actions', () => {
  it("resolves the caller's thread and who it acts as", () => {
    expect(artifactsScope('agent:astra', null)).toEqual({ thread: 'assistant:astra', by: 'astra' })
    expect(artifactsScope('page:agent:nova', null)).toEqual({
      thread: 'assistant:nova',
      by: 'nova',
    })
    const sessions = new Map<string, RelaySession>([
      [
        's1',
        {
          id: 's1',
          status: 'idle',
          detail: null,
          canRespond: true,
          kind: 'manual',
          title: 'Fix the header',
          assistant: null,
        },
      ],
    ])
    expect(artifactsScope(FILE, sessions)).toEqual({ thread: 'session:s1', by: 'Fix the header' })
    expect(artifactsScope(`chat:${FILE}`, null)).toEqual({ thread: 'session:s1', by: 'chat s1' })
    expect(() => artifactsScope(undefined, null)).toThrow(/calling session/)
  })

  it('lists tabs and a tab’s items, and passes host refusals through word for word', async () => {
    const relay = new FakeRelay()
    const pr = item('gh-pr:o/r#1', {
      status: { state: 'open', fetchedAt: 1 },
      pinned: { by: 'isaac', at: 1 },
    })
    relay.map.set('assistant:astra', {
      items: [pr],
      tabs: [
        {
          id: 'links',
          title: 'Links',
          createdBy: 'default',
          createdAt: 0,
          rule: { kind: ['gh-pr'] },
          hidden: false,
        },
      ],
    })
    const run = artifactsRunners(relay)
    expect(await run['artifacts.list']({ tab: 'links', scope: 'agent:astra' })).toEqual({
      thread: 'assistant:astra',
      tabs: [
        {
          id: 'links',
          title: 'Links',
          rule: { kind: ['gh-pr'] },
          createdBy: 'default',
          hidden: false,
        },
      ],
      tab: 'links',
      items: [{ id: pr.id, kind: 'gh-pr', title: pr.title, state: 'open', pinned: true }],
    })
    await expect(run['artifacts.list']({ tab: 'nope', scope: 'agent:astra' })).rejects.toThrow(
      /No tab nope/,
    )
    relay.answer = { ok: true, id: 'open-prs' }
    expect(
      await run['artifacts.tab.add']({
        title: 'Open PRs',
        rule: { kind: ['gh-pr'], state: ['open'] },
        scope: 'agent:astra',
      }),
    ).toEqual({ id: 'open-prs' })
    expect(relay.acts.at(-1)).toEqual({
      thread: 'assistant:astra',
      by: 'astra',
      action: { op: 'tab.add', title: 'Open PRs', rule: { kind: ['gh-pr'], state: ['open'] } },
    })
    await run['artifacts.unpin']({ id: pr.id, scope: 'agent:astra' })
    expect(relay.acts.at(-1)!.action).toEqual({ op: 'pin', id: pr.id, pinned: false })
    await run['artifacts.tab.update']({ id: 'open-prs', index: 4, scope: 'agent:astra' })
    expect(relay.acts.at(-1)!.action).toEqual({ op: 'tab.update', tab: 'open-prs', index: 4 })
    relay.answer = { ok: false, error: 'Isaac hid a tab like this; it stays hidden.' }
    await expect(
      run['artifacts.tab.remove']({ id: 'links', scope: 'agent:astra' }),
    ).rejects.toThrow('Isaac hid a tab like this; it stays hidden.')
  })
})
