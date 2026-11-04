import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { createConfigStore } from '../config-store'
import type { MainContext } from '../context'
import type { RelayFrames } from '../relay/client'
import type { HostAnswer, HostOp, HostReviews } from '../relay/host-reviews'
import {
  absoluteMedia,
  hostLinearIssue,
  hostPrFacts,
  refOf,
  registerRemoteReviews,
  slackTs,
  toPr,
  type HostQueue,
} from './remote-reviews'

const idle = { loading: false, error: null, fetchedAt: 1000 }
const PR = 'https://github.com/eCardSystems/api/pull/170'
const SLACK =
  'https://ecard.slack.com/archives/C0123ABCD/p1761000000123456?thread_ts=1761000000.000100'
const queue: HostQueue = {
  items: [
    {
      url: PR,
      ref: { kind: 'github', repo: 'eCardSystems/api', number: 170 },
      title: 'Lock edits',
      actor: 'dana',
      reason: 'requested your review',
      label: '#170',
      updatedAt: 900,
      unread: true,
      draft: true,
      group: 'needs',
    },
    {
      url: 'https://linear.app/ecard/issue/ENG-1/fix',
      ref: { kind: 'linear', key: 'ENG-1' },
      title: 'Fix it',
      actor: 'Sam',
      reason: 'mentioned you',
      label: 'ENG-1',
      updatedAt: 800,
      unread: false,
    },
    {
      url: SLACK,
      ref: { kind: 'slack', channel: 'C0123ABCD', threadTs: '1761000000.000100' },
      title: 'can you look?',
      actor: 'Lee',
      reason: 'asked you',
      label: '#ui-ux',
      updatedAt: 700,
      unread: true,
      slackKind: 'mention',
    },
  ],
  done: { [PR]: 1 },
  sources: { github: idle, linear: idle, slack: idle },
}

class FakeHost implements HostReviews {
  ops: HostOp[] = []
  answers: Record<string, (op: HostOp) => HostAnswer | Promise<HostAnswer>> = {}
  private pushes = new Set<(f: Record<string, unknown>) => void>()
  req(op: HostOp): Promise<HostAnswer> {
    this.ops.push(op)
    const answer = this.answers[op.kind]
    return answer ? Promise.resolve(answer(op)) : Promise.reject(new Error(`no ${op.kind}`))
  }
  onPush(cb: (f: Record<string, unknown>) => void): () => void {
    this.pushes.add(cb)
    return () => this.pushes.delete(cb)
  }
  push(f: Record<string, unknown>): void {
    for (const cb of [...this.pushes]) cb(f)
  }
}

let dir: string
let host: FakeHost
let sent: Array<Record<string, unknown>>
let emitted: Array<[string, unknown]>
beforeEach(() => {
  ipc.handlers.clear()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-reviews-'))
  host = new FakeHost()
  sent = []
  emitted = []
  const frames: RelayFrames = {
    onFrame: () => () => undefined,
    sendFrame: (f) => {
      sent.push(f)
      return true
    },
  }
  const ctx = {
    config: createConfigStore(dir),
    shell: {
      webContents: {
        isDestroyed: () => false,
        send: (c: string, p: unknown) => emitted.push([c, p]),
      },
    },
  } as unknown as MainContext
  registerRemoteReviews(ctx, {
    host,
    frames,
    origin: () => 'http://100.85.157.127:7817',
    sessionFile: (id) => (id === 's1' ? '/mirror/2026_s1.jsonl' : null),
    writes: true,
  })
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

async function call(
  channel: string,
  input: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  return (await ipc.handlers.get(channel)!({ senderFrame: { url: 'app://shell' } }, input)) as never
}

describe('mappings', () => {
  it('reads a Slack ts from the permalink, else from the row time', () => {
    expect(slackTs(SLACK, 0)).toBe('1761000000.123456')
    expect(slackTs('https://x.slack.com/archives/D1', 1761000000123)).toBe('1761000000.123000')
  })

  it('names an item by the queue’s ref, else from its url', () => {
    expect(refOf(SLACK, queue.items)).toEqual({
      kind: 'slack',
      channel: 'C0123ABCD',
      threadTs: '1761000000.000100',
    })
    expect(refOf('https://github.com/o/r/pull/9', [])).toEqual({
      kind: 'github',
      repo: 'o/r',
      number: 9,
    })
    expect(refOf('https://linear.app/issue/ENG-7', [])).toEqual({ kind: 'linear', key: 'ENG-7' })
    expect(refOf('https://x.slack.com/archives/D0AB/p1761000000123456', [])).toEqual({
      kind: 'slack',
      channel: 'D0AB',
      threadTs: null,
    })
    expect(refOf('https://example.com', [])).toBeNull()
  })

  it('points host image paths at the host, leaving other links alone', () => {
    expect(
      absoluteMedia('a ![x](/reviews/media/f.png/tok) [l](/reviews/media/y)', 'http://h:1'),
    ).toBe('a ![x](http://h:1/reviews/media/f.png/tok) [l](/reviews/media/y)')
  })

  it('moves commits out of the PR timeline', () => {
    const pr = toPr({
      repo: 'o/r',
      number: 1,
      title: 't',
      url: 'u',
      state: 'OPEN',
      draft: false,
      author: { login: 'dana' },
      createdAt: 1,
      updatedAt: 2,
      body: '',
      base: 'main',
      head: 'eng-1',
      additions: 1,
      deletions: 0,
      reviewers: [],
      assignees: [],
      labels: [],
      timeline: [
        { kind: 'commit', author: 'dana', body: 'first', state: 'abc1234', at: 1 },
        { kind: 'comment', author: 'sam', body: 'hi', state: null, at: 2 },
      ],
      checks: [],
      files: [],
      diff: '',
    })
    expect(pr.commits).toEqual([{ oid: 'abc1234', headline: 'first', author: 'dana', at: 1 }])
    expect(pr.timeline).toEqual([
      { kind: 'comment', author: 'sam', body: 'hi', state: null, at: 2 },
    ])
    expect(pr).toMatchObject({ milestone: null, projects: [], participants: ['dana', 'sam'] })
  })
})

describe('the page through the host', () => {
  it('builds the queue from the host’s queue and its Completed/Created lists, reusing one queue read', async () => {
    host.answers.queue = () => ({ queue })
    host.answers.prList = (op) => ({
      prs: { items: op.list === 'created' ? [queue.items[0]] : [], total: 7 },
    })
    const q = await call('reviews.queue', { refresh: false })
    expect(q.value).toMatchObject({
      needs: [{ repo: 'eCardSystems/api', number: 170, author: 'dana', draft: true }],
      reviewing: [],
      completed: [],
      completedTotal: 7,
      created: [{ number: 170 }],
      done: { [PR]: 1 },
      fetchedAt: 1000,
    })
    const linear = await call('reviews.linearQueue', { refresh: false })
    expect(linear.value).toEqual([
      {
        key: 'ENG-1',
        title: 'Fix it',
        url: queue.items[1]!.url,
        reason: 'mentioned you',
        actor: 'Sam',
        updatedAt: 800,
        unread: false,
      },
    ])
    const slack = await call('reviews.slackQueue', { refresh: false })
    expect(slack.value).toMatchObject({
      fetchedAt: 1000,
      rows: [{ kind: 'mention', channel: 'C0123ABCD', ts: '1761000000.123456' }],
    })
    expect(host.ops.filter((o) => o.kind === 'queue')).toHaveLength(1)
  })

  it('says why GitHub failed when the host never read it', async () => {
    host.answers.queue = () => ({
      queue: {
        ...queue,
        items: [],
        sources: {
          ...queue.sources,
          github: { loading: false, error: 'gh auth failed', fetchedAt: null },
        },
      },
    })
    host.answers.prList = () => ({ prs: { items: [], total: 0 } })
    const q = await call('reviews.queue', { refresh: true })
    expect(q).toMatchObject({ ok: false, error: { code: 'gh-failed', message: 'gh auth failed' } })
  })

  it('a Slack refresh waits for the host’s background read', async () => {
    host.answers.queue = () => ({
      queue: {
        ...queue,
        sources: { ...queue.sources, slack: { loading: true, error: null, fetchedAt: 1000 } },
      },
    })
    let got: unknown
    const p = call('reviews.slackQueue', { refresh: true }).then((r) => (got = r.value))
    const finished = {
      ...queue,
      items: [],
      sources: { ...queue.sources, slack: { loading: false, error: null, fetchedAt: 2000 } },
    }
    // On the wire the push follows the answer; it is repeated until the handler has taken the answer.
    await vi.waitFor(() => {
      host.push({ t: 'reviews.queue', queue: finished })
      expect(got).toBeDefined()
    })
    await p
    expect(got).toEqual({ rows: [], fetchedAt: 2000 })
    expect(host.ops).toHaveLength(1)
  })

  it('PR images the host serves are fetched once and served locally', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      expect(url).toBe('http://100.85.157.127:7817/reviews/media/abc.png/tok')
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
    })
    host.answers.pr = () => ({
      pr: {
        repo: 'o/r',
        number: 1,
        title: 't',
        url: 'u',
        state: 'OPEN',
        draft: false,
        author: { login: 'd' },
        createdAt: 1,
        updatedAt: 2,
        body: 'see ![shot](/reviews/media/abc.png/tok)',
        base: 'main',
        head: 'h',
        headSha: 'x',
        additions: 0,
        deletions: 0,
        reviewers: [],
        assignees: [],
        labels: [],
        timeline: [],
        checks: [],
        files: [],
        diff: '',
        diffTruncated: false,
      },
    })
    const r = await call('reviews.pr', { repo: 'o/r', number: 1 })
    expect(r.value).toMatchObject({
      body: expect.stringMatching(/^see !\[shot\]\(\/reviews\/media\/[0-9a-f]{40}\.png\)$/),
    })
  })

  it('row pills come from the host’s prView', async () => {
    host.answers.prView = () => ({
      view: {
        isDraft: false,
        reviewDecision: 'APPROVED',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
      },
    })
    expect((await call('reviews.rowStatus', { repo: 'o/r', number: 1 })).value).toEqual({
      draft: false,
      ci: 'fail',
      decision: 'APPROVED',
    })
  })

  it('asks Astra on the Mini with the item’s ref, keeps her file, and Stop aborts her live session', async () => {
    host.answers.queue = () => ({ queue })
    host.answers.prList = () => ({ prs: { items: [], total: 0 } })
    await call('reviews.queue', { refresh: false })
    host.answers.astraAsk = (op) => ({
      astra: {
        url: op.url,
        title: 'Astra · #ui-ux',
        sessionId: 's1',
        turns: [],
        working: true,
        waiting: null,
        error: null,
      },
    })
    const asked = await call('reviews.astraAsk', {
      url: SLACK,
      label: '#ui-ux',
      context: 'ignored',
      text: 'what is this?',
    })
    expect(host.ops.at(-1)).toEqual({
      kind: 'astraAsk',
      url: SLACK,
      ref: queue.items[2]!.ref,
      text: 'what is this?',
    })
    expect(asked.value).toMatchObject({ file: '/mirror/2026_s1.jsonl', working: true })
    expect(asked.value).not.toHaveProperty('sessionId')
    expect((await call('reviews.astraStop', { url: SLACK })).value).toEqual({ stopped: true })
    expect(sent.at(-1)).toMatchObject({ t: 'cmd', cmd: { kind: 'agent.abort', sessionId: 's1' } })
    // Ended on the Mini: the file stays known for "Open in chat".
    host.push({
      t: 'reviews.astra',
      item: {
        url: SLACK,
        title: 'Astra · #ui-ux',
        sessionId: null,
        turns: [],
        working: false,
        waiting: null,
        error: null,
      },
    })
    expect(emitted.at(-1)).toEqual([
      'reviews.astraUpdate',
      expect.objectContaining({ file: '/mirror/2026_s1.jsonl', working: false }),
    ])
  })

  it('Done goes to the host’s marks', async () => {
    host.answers.done = (op) => ({ done: { [op.url as string]: op.updatedAt as number } })
    expect((await call('reviews.done', { url: PR, updatedAt: 5, done: true })).value).toEqual({
      [PR]: 5,
    })
  })
})

describe('readers', () => {
  it('PR facts from prView, null when the host can’t say', async () => {
    host.answers.prView = () => ({
      view: {
        number: 1,
        title: 't',
        url: 'u',
        state: 'OPEN',
        isDraft: false,
        reviewDecision: null,
        baseRefName: 'main',
        headRefName: 'eng-1',
        additions: 1,
        deletions: 2,
        statusCheckRollup: [],
        latestReviews: [],
      },
    })
    expect(await hostPrFacts(host)('o/r', 1)).toMatchObject({
      repo: 'o/r',
      number: 1,
      head: 'eng-1',
    })
    host.answers.prView = () => Promise.reject(new Error('gh pr view failed'))
    expect(await hostPrFacts(host)('o/r', 1)).toBeNull()
  })

  it('a Linear issue from the host’s ticket; not found is null', async () => {
    host.answers.linear = () => ({
      ticket: {
        key: 'ENG-1',
        title: 'Fix',
        url: 'u',
        updatedAt: 3,
        state: { name: 'In Progress', type: 'started' },
        assignee: null,
        priority: 'High',
        project: null,
      },
    })
    expect(await hostLinearIssue(host)('ENG-1')).toEqual({
      identifier: 'ENG-1',
      title: 'Fix',
      url: 'u',
      state: 'In Progress',
      stateType: 'started',
      priority: 'High',
      assignee: null,
      project: null,
      updatedAt: 3,
    })
    host.answers.linear = () => Promise.reject(new Error('Entity not found: Issue'))
    expect(await hostLinearIssue(host)('ENG-404')).toBeNull()
  })
})
