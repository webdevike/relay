import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewGuide, ReviewPr } from '@evaos/contract'
import fixture from '@relay/protocol/fixtures/review-guide.json'
import type { MainContext } from '../context'
import type { ToolRun } from '../context-popover/pr-source'
import { createConfigStore } from '../config-store'
import type * as GuideModule from './guide'
import { registerReviewsIpc } from './reviews-ipc'

const handlers = new Map<string, (args: unknown) => Promise<unknown>>()
vi.mock('../ipc/handle', () => ({
  handle: (_ctx: unknown, channel: string, fn: (args: unknown) => Promise<unknown>) =>
    handlers.set(channel, fn),
}))
vi.mock('./linear-inbox', () => ({ registerLinearInbox: () => {} }))
vi.mock('./slack-inbox', () => ({ registerSlackInbox: () => {} }))
vi.mock('./astra-sessions', () => ({ registerAstraSessions: () => {} }))
const write = vi.fn(async (_prompt: string) => fixture.answer)
vi.mock('./guide', async (actual) => ({
  ...(await actual<typeof GuideModule>()),
  claudeWriter: () => write,
}))

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const BASE = 'c'.repeat(40)
const raw = (head: string) => ({
  number: 7,
  title: 'Lock',
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'sam' },
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  body: '',
  baseRefName: 'main',
  headRefName: 'lock',
  headRefOid: head,
  baseRefOid: BASE,
  additions: 1,
  deletions: 1,
  commits: [],
  files: fixture.input.files,
  reviewRequests: [],
  latestReviews: [],
  reviews: [],
  comments: [],
  assignees: [],
  labels: [],
  milestone: null,
  projectItems: [],
  statusCheckRollup: [],
})

let dir: string
let head: string
/** Where gh's head is after it answers a view (a push landing between two reads). */
let pushAfterView: string | null
let calls: string[][]
const run: ToolRun = async (_bin, args) => {
  calls.push(args)
  if (args[0] === 'pr' && args[1] === 'view') {
    const out = JSON.stringify(raw(head))
    if (pushAfterView) head = pushAfterView
    return { code: 0, stdout: out }
  }
  const compare = /^repos\/o\/r\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(args[1] ?? '')
  if (args[0] === 'api' && compare?.[1] === BASE && compare[2] === A)
    return { code: 0, stdout: fixture.input.diff }
  if (args[0] === 'api' && compare?.[1] === BASE && compare[2] === B)
    return { code: 0, stdout: `${fixture.input.diff}diff --git a/b.ts b/b.ts\n` }
  return { code: 1, stdout: '' }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews-snapshot-'))
  head = A
  pushAfterView = null
  calls = []
  write.mockClear()
  const ctx = {
    config: createConfigStore(dir),
    env: { live: true, e2e: false, claudeBin: 'claude', evaRoot: dir, configDir: dir },
  } as unknown as MainContext
  registerReviewsIpc(ctx, run)
})
afterEach(() => {
  handlers.clear()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('reviews PR and Guide read one base...head snapshot', () => {
  it('reads the diff at the viewed commits even when a push lands between the two reads', async () => {
    pushAfterView = B
    const pr = (await handlers.get('reviews.pr')!({ repo: 'o/r', number: 7 })) as ReviewPr
    expect([pr.headSha, pr.baseSha]).toEqual([A, BASE])
    expect(pr.diff).toBe(fixture.input.diff)
    expect(calls[1]).toEqual([
      'api',
      `repos/o/r/compare/${BASE}...${A}`,
      '-H',
      'Accept: application/vnd.github.diff',
    ])
    expect(calls.some((c) => c[0] === 'pr' && c[1] === 'diff')).toBe(false)
  })

  it('refuses the Guide for a head the PR moved past, then writes it for the reloaded head', async () => {
    const guide = handlers.get('reviews.guide')!
    head = B
    await expect(guide({ repo: 'o/r', number: 7, headSha: A, baseSha: BASE })).rejects.toThrow(
      'PR changed; regenerating',
    )
    await expect(
      guide({ repo: 'o/r', number: 7, headSha: B, baseSha: 'd'.repeat(40) }),
    ).rejects.toThrow('PR changed; regenerating')
    expect(write).not.toHaveBeenCalled()
    const g = (await guide({ repo: 'o/r', number: 7, headSha: B, baseSha: BASE })) as ReviewGuide
    expect(g).toMatchObject({ headSha: B, source: 'model', version: 2 })
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]![0]).toContain('FILE b.ts')
  })
})
