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

import { rewriteImages } from '@relay/protocol/markdown-images'
import { createConfigStore } from '../config-store'
import type { MainContext } from '../context'
import { REVIEWS_ACTIONS_FEATURE, REVIEWS_ASSISTANTS_FEATURE } from '@relay/protocol'
import type { RelayFeatures, RelayFrames } from '../relay/client'
import type { HostAnswer, HostOp, HostReviews } from '../relay/host-reviews'
import {
  LEGACY_COMMENT_REFUSED,
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
let features: Set<string>
beforeEach(() => {
  ipc.handlers.clear()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-reviews-'))
  host = new FakeHost()
  sent = []
  emitted = []
  features = new Set()
  const frames: RelayFrames & RelayFeatures = {
    onFrame: () => () => undefined,
    sendFrame: (f) => {
      sent.push(f)
      return true
    },
    hostHas: (feature) => features.has(feature),
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

  it('points host image paths at the host, leaving other links and the unavailable placeholder alone', () => {
    expect(
      absoluteMedia('a ![x](/reviews/media/f.png/tok) [l](/reviews/media/y)', 'http://h:1'),
    ).toBe('a ![x](http://h:1/reviews/media/f.png/tok) [l](/reviews/media/y)')
    expect(absoluteMedia('![x](/reviews/media/unavailable "w=320")', 'http://h:1')).toBe(
      '![x](/reviews/media/unavailable "w=320")',
    )
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

  it('marks a capable host’s read writeGate (with or without actions facts); an old host’s facts are dropped', async () => {
    const actions = {
      viewerLogin: 'webdevike',
      viewerPermission: 'WRITE',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      methods: { merge: true, squash: true, rebase: false },
      mergeQueue: { required: false, inQueue: false, entryState: null },
      reviews: [],
      checks: [],
    }
    const pr = (over: Record<string, unknown>) => ({
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
        body: '',
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
        ...over,
      },
    })
    const read = async () =>
      (await call('reviews.pr', { repo: 'o/r', number: 1 })).value as Record<string, unknown>
    host.answers.pr = () => pr({ actions })
    expect(await read()).not.toHaveProperty('writeGate')
    expect(await read()).not.toHaveProperty('actions')
    features.add(REVIEWS_ACTIONS_FEATURE)
    expect(await read()).toMatchObject({ writeGate: true, actions: { viewerLogin: 'webdevike' } })
    host.answers.pr = () => pr({})
    const bare = await read()
    expect(bare).toMatchObject({ writeGate: true })
    expect(bare).not.toHaveProperty('actions')
  })

  it('refuses the legacy comment while the host takes PR writes; an older host still gets it', async () => {
    host.answers.comment = () => ({ url: 'https://github.com/o/r/pull/1#c' })
    features.add(REVIEWS_ACTIONS_FEATURE)
    expect(await call('reviews.comment', { repo: 'o/r', number: 1, body: 'hi' })).toMatchObject({
      ok: false,
      error: { code: 'use-gate', message: LEGACY_COMMENT_REFUSED },
    })
    expect(host.ops).toEqual([])
    features.clear()
    expect(await call('reviews.comment', { repo: 'o/r', number: 1, body: 'hi' })).toMatchObject({
      ok: true,
    })
    expect(host.ops.map((o) => o.kind)).toEqual(['comment'])
  })

  it('loads images the host rewrote from reference and entity-escaped forms: inline host paths, fetched and served locally', async () => {
    // What the host's localizer answers (`@relay/protocol/markdown-images` with its served `<file>/<token>` paths).
    const signed = 'https://private-user-images.githubusercontent.com/1/x.png?jwt=SECRETJWT'
    const served = (n: string) => `/reviews/media/${n.repeat(40)}.png/tok${n}`
    const hosted = new Map([[signed, served('a')]])
    const body = rewriteImages(
      [
        `![ref][shot]`,
        `[![linked][shot]](${signed})`,
        `![escaped](https&#58;//private-user-images.githubusercontent.com/1/x.png?jwt=SECRETJWT)`,
        `[shot]: ${signed}`,
      ].join('\n\n'),
      (u) => hosted.get(u),
    )
    expect(body).not.toMatch(/^\[shot\]:/m)
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      fetched.push(url)
      return new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } })
    })
    host.answers.pr = () => ({
      pr: {
        repo: 'o/r',
        number: 2,
        title: 't',
        url: 'u',
        state: 'OPEN',
        draft: false,
        author: { login: 'd' },
        createdAt: 1,
        updatedAt: 2,
        body,
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
    const r = await call('reviews.pr', { repo: 'o/r', number: 2 })
    const local = /\/reviews\/media\/[0-9a-f]{40}\.png/.source
    expect((r.value as { body: string }).body.split('\n\n').filter(Boolean)).toEqual([
      expect.stringMatching(new RegExp(`^!\\[ref\\]\\(${local}\\)$`)),
      expect.stringMatching(new RegExp(`^!\\[linked\\]\\(${local}\\)$`)),
      expect.stringMatching(new RegExp(`^!\\[escaped\\]\\(${local}\\)$`)),
    ])
    expect(fetched).toEqual([`http://100.85.157.127:7817${served('a')}`])
    expect(JSON.stringify(r.value)).not.toMatch(/SECRETJWT|jwt=|private-user-images|tok/)
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

  it('sends `agent` only to a host that runs other assistants, and keeps each one’s session apart', async () => {
    host.answers.queue = () => ({ queue })
    host.answers.prList = () => ({ prs: { items: [], total: 0 } })
    await call('reviews.queue', { refresh: false })
    host.answers.astraAsk = (op) => ({
      astra: {
        url: op.url,
        title: 'Nova · #ui-ux',
        sessionId: 'n1',
        turns: [],
        working: true,
        waiting: null,
        error: null,
        agent: op.agent,
      },
    })
    host.answers.astra = () => ({ astra: null })
    const ask = { url: SLACK, label: '#ui-ux', context: '', text: 'hi', agent: 'nova' }
    // An older host: Nova is refused here, Astra goes without the field, nothing unknown is sent.
    expect((await call('reviews.astraAsk', ask)).ok).toBe(false)
    expect(await call('reviews.astraThread', { url: SLACK, agent: 'nova' })).toMatchObject({
      value: null,
    })
    expect(host.ops.filter((op) => 'agent' in op)).toEqual([])
    await call('reviews.astraThread', { url: SLACK, agent: 'astra' })
    expect(host.ops.at(-1)).toEqual({ kind: 'astra', url: SLACK })

    features.add(REVIEWS_ASSISTANTS_FEATURE)
    const asked = await call('reviews.astraAsk', ask)
    expect(host.ops.at(-1)).toMatchObject({ kind: 'astraAsk', url: SLACK, agent: 'nova' })
    expect(asked.value).toMatchObject({ agent: 'nova', file: null })
    // Nova's live session is hers: Astra's Stop on the same item does not reach it.
    expect((await call('reviews.astraStop', { url: SLACK })).value).toEqual({ stopped: false })
    expect((await call('reviews.astraStop', { url: SLACK, agent: 'nova' })).value).toEqual({
      stopped: true,
    })
    expect(sent.at(-1)).toMatchObject({ cmd: { kind: 'agent.abort', sessionId: 'n1' } })
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
