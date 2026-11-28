// Local mode (the Mini) and the PR read: gh exactly as before unless the connected host takes PR
// writes (reviews.actions); then the host reads it as one snapshot and owns its comments.
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
vi.mock('./linear-inbox', () => ({ registerLinearInbox: () => {} }))
vi.mock('./slack-inbox', () => ({ registerSlackInbox: () => {} }))

import { REVIEWS_ACTIONS_FEATURE, TICKETS_FEATURE, TICKETS_WRITES_FEATURE } from '@relay/protocol'
import type { ReviewPr } from '@evaos/contract'
import { createConfigStore } from '../config-store'
import type { MainContext } from '../context'
import type { ToolRun } from '../context-popover/pr-source'
import type { RelayFeatures, RelayFrames } from '../relay/client'
import { LEGACY_COMMENT_REFUSED } from './remote-reviews'
import { registerReviewsIpc } from './reviews-ipc'

type Frame = Record<string, unknown>

const HEAD = 'a'.repeat(40)
const BASE = 'c'.repeat(40)
const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n'

/** gh's `pr view --json` answer for o/r#7. */
const raw = {
  number: 7,
  title: 'Lock',
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'sam' },
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  body: 'From gh',
  baseRefName: 'main',
  headRefName: 'lock',
  headRefOid: HEAD,
  baseRefOid: BASE,
  additions: 1,
  deletions: 1,
  commits: [],
  files: [{ path: 'a.ts', additions: 1, deletions: 1 }],
  reviewRequests: [],
  latestReviews: [],
  reviews: [],
  comments: [{ author: { login: 'noah' }, body: 'Looks right', createdAt: '2026-11-01T01:00:00Z' }],
  assignees: [],
  labels: [],
  milestone: null,
  projectItems: [],
  statusCheckRollup: [],
}

const ACTIONS = {
  viewerLogin: 'webdevike',
  viewerPermission: 'WRITE',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  methods: { merge: true, squash: true, rebase: false },
  autoMerge: null,
  mergeQueue: { required: false, inQueue: false, entryState: null },
  reviews: [],
  checks: [],
}

/** The host's `pr` answer (relay protocol ReviewPr). */
const hostPr = (over: Frame = {}): Frame => ({
  repo: 'o/r',
  number: 7,
  title: 'Lock',
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  draft: false,
  author: { login: 'sam' },
  createdAt: 1,
  updatedAt: 2,
  body: 'From the host',
  base: 'main',
  head: 'lock',
  headSha: HEAD,
  baseSha: BASE,
  additions: 1,
  deletions: 1,
  reviewers: [],
  assignees: [],
  labels: [],
  timeline: [],
  checks: [],
  files: [{ path: 'a.ts', additions: 1, deletions: 1, change: 'MODIFIED' }],
  diff: DIFF,
  ...over,
})

let dir: string
let gh: string[][]
let sent: Frame[]
let features: Set<string>
let connected: boolean
let answers: Record<string, (op: Frame) => Frame>

const run: ToolRun = async (_bin, args) => {
  gh.push(args)
  if (args[0] === 'pr' && args[1] === 'view') return { code: 0, stdout: JSON.stringify(raw) }
  if (args[0] === 'api' && args[1] === `repos/o/r/compare/${BASE}...${HEAD}`)
    return { code: 0, stdout: DIFF }
  if (args[0] === 'pr' && args[1] === 'comment')
    return { code: 0, stdout: 'https://github.com/o/r/pull/7#issuecomment-1' }
  return { code: 1, stdout: '' }
}

/** The local Relay connection: answers `reviews.req` by op kind; never authenticated while `connected` is false. */
function framesOf(): RelayFrames & RelayFeatures {
  const listeners = new Set<(f: Frame) => void>()
  return {
    onFrame: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    hostHas: (f) => connected && features.has(f),
    sendFrame: (frame) => {
      sent.push(frame)
      if (!connected) return false
      const op = frame.op as Frame
      const answer = answers[String(op.kind)]?.(op) ?? { ok: false, error: `no ${String(op.kind)}` }
      const res = { t: 'reviews.res', rid: frame.rid, ok: true, ...answer }
      queueMicrotask(() => {
        for (const cb of [...listeners]) cb(res)
      })
      return true
    },
  }
}

function register(frames: (RelayFrames & RelayFeatures) | null): void {
  ipc.handlers.clear()
  const ctx = {
    config: createConfigStore(dir),
    env: { live: true, e2e: false, claudeBin: 'claude', evaRoot: dir, configDir: dir },
    onBeforeQuit: () => {},
  } as unknown as MainContext
  registerReviewsIpc(ctx, run, null, frames, () => 'http://127.0.0.1:7817')
}

async function call(
  channel: string,
  input: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  return (await ipc.handlers.get(channel)!({ senderFrame: { url: 'app://shell' } }, input)) as never
}

const readPr = async (): Promise<ReviewPr> => {
  const r = await call('reviews.pr', { repo: 'o/r', number: 7 })
  expect(r.ok).toBe(true)
  return r.value as ReviewPr
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-host-pr-'))
  gh = []
  sent = []
  features = new Set()
  connected = true
  answers = {}
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('local mode without a host that takes PR writes', () => {
  it.each([
    ['flags off (tickets sync only)', [TICKETS_FEATURE], true],
    ['writes on but no reviews.actions', [TICKETS_FEATURE, TICKETS_WRITES_FEATURE], true],
    ['an old host', [], true],
    ['the host disconnected', [REVIEWS_ACTIONS_FEATURE], false],
  ])(
    '%s: gh reads the PR exactly as with no host, and the host is never asked',
    async (_, list, up) => {
      register(null)
      const before = await readPr()
      const ghBefore = gh
      gh = []
      features = new Set(list)
      connected = up
      register(framesOf())
      const pr = await readPr()
      expect(pr).toEqual(before)
      expect(pr.writeGate).toBeUndefined()
      expect(pr.actions).toBeUndefined()
      expect(pr.body).toBe('From gh')
      expect(gh).toEqual(ghBefore)
      expect(sent).toEqual([])
    },
  )

  it('the confirmed legacy comment still posts through gh', async () => {
    features = new Set([TICKETS_FEATURE])
    register(framesOf())
    const r = await call('reviews.comment', { repo: 'o/r', number: 7, body: 'Ship it' })
    expect(r.ok).toBe(true)
    expect(gh).toEqual([['pr', 'comment', '7', '-R', 'o/r', '--body', 'Ship it']])
    expect(sent).toEqual([])
  })
})

describe('local mode with a host that takes PR writes (reviews.actions)', () => {
  beforeEach(() => {
    features = new Set([TICKETS_FEATURE, TICKETS_WRITES_FEATURE, REVIEWS_ACTIONS_FEATURE])
  })

  it('the host reads the PR: one snapshot with its actions facts and line comments, gh not asked', async () => {
    const line = {
      id: 501,
      inReplyTo: null,
      path: 'a.ts',
      line: 1,
      originalLine: 1,
      side: 'RIGHT',
      outdated: false,
      author: 'noah',
      body: 'Why?',
      at: 3,
    }
    answers.pr = () => ({ pr: hostPr({ actions: ACTIONS, reviewComments: [line] }) })
    register(framesOf())
    const pr = await readPr()
    expect(pr).toMatchObject({
      body: 'From the host',
      headSha: HEAD,
      writeGate: true,
      actions: { viewerLogin: 'webdevike' },
      reviewComments: [{ id: 501 }],
    })
    expect(gh).toEqual([])
    expect(sent.map((f) => (f.op as Frame).kind)).toEqual(['pr'])
  })

  it('a host read without actions facts stays marked writeGate (the page refuses comments, no legacy)', async () => {
    answers.pr = () => ({ pr: hostPr() })
    register(framesOf())
    const pr = await readPr()
    expect(pr.writeGate).toBe(true)
    expect(pr.actions).toBeUndefined()
    expect(gh).toEqual([])
  })

  it('a host that cannot answer leaves gh’s read, marked writeGate and without actions', async () => {
    register(framesOf())
    const pr = await readPr()
    expect(pr).toMatchObject({ body: 'From gh', writeGate: true })
    expect(pr.actions).toBeUndefined()
    expect(sent.map((f) => (f.op as Frame).kind)).toEqual(['pr'])
  })

  it('refuses the legacy comment: nothing reaches gh or the host', async () => {
    register(framesOf())
    const r = await call('reviews.comment', { repo: 'o/r', number: 7, body: 'Ship it' })
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'use-gate', message: LEGACY_COMMENT_REFUSED },
    })
    expect(gh).toEqual([])
    expect(sent).toEqual([])
  })
})
