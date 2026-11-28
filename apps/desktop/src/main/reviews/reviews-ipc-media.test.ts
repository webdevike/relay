import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewPr } from '@evaos/contract'
import signedImages from '@relay/protocol/fixtures/signed-images.json'
import type { MainContext } from '../context'
import type { ToolRun } from '../context-popover/pr-source'
import { createConfigStore } from '../config-store'
import { registerReviewsIpc } from './reviews-ipc'

const handlers = new Map<string, (args: unknown) => Promise<unknown>>()
vi.mock('../ipc/handle', () => ({
  handle: (_ctx: unknown, channel: string, fn: (args: unknown) => Promise<unknown>) =>
    handlers.set(channel, fn),
}))
vi.mock('./linear-inbox', () => ({ registerLinearInbox: () => {} }))
vi.mock('./slack-inbox', () => ({ registerSlackInbox: () => {} }))
vi.mock('./astra-sessions', () => ({ registerAstraSessions: () => {} }))

const HEAD = 'a'.repeat(40)
const BASE = 'c'.repeat(40)
const forms = Object.values(signedImages.forms)
const raw = {
  number: 7,
  title: 'Lock',
  url: 'https://github.com/o/r/pull/7',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'sam' },
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  body: forms.join('\n\n'),
  baseRefName: 'main',
  headRefName: 'lock',
  headRefOid: HEAD,
  baseRefOid: BASE,
  additions: 0,
  deletions: 0,
  commits: [],
  files: [],
  reviewRequests: [],
  latestReviews: [],
  reviews: forms.map((body) => ({
    author: { login: 'sam' },
    state: 'COMMENTED',
    body,
    submittedAt: '2026-11-01T00:00:00Z',
  })),
  comments: forms.map((body) => ({
    author: { login: 'sam' },
    body,
    createdAt: '2026-11-01T00:00:00Z',
  })),
  assignees: [],
  labels: [],
  milestone: null,
  projectItems: [],
  statusCheckRollup: [],
}
const run: ToolRun = async (_bin, args) => {
  if (args[0] === 'pr' && args[1] === 'view') return { code: 0, stdout: JSON.stringify(raw) }
  if (args[0] === 'api' && args[1] === `repos/o/r/compare/${BASE}...${HEAD}`)
    return { code: 0, stdout: '' }
  if (args[0] === 'auth') return { code: 0, stdout: 'tok\n' }
  return { code: 1, stdout: '' }
}

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviews media ipc '))
  const ctx = {
    config: createConfigStore(dir),
    env: { live: true, e2e: false, claudeBin: 'claude', evaRoot: dir, configDir: dir },
  } as unknown as MainContext
  registerReviewsIpc(ctx, run)
})
afterEach(() => {
  handlers.clear()
  vi.unstubAllGlobals()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('reviews.pr answers no signed image URL', () => {
  it.each([
    [
      'served',
      async () =>
        new Response(new Uint8Array([0x89, 0x50]), { headers: { 'content-type': 'image/png' } }),
      /\/reviews\/media\/[0-9a-f]{40}\.png/,
    ],
    [
      'unavailable',
      async () => new Response('no', { status: 404 }),
      /\/reviews\/media\/unavailable/,
    ],
  ] as const)(
    'in a body, comments and reviews holding every signed image form (%s)',
    async (_, fetchFn, local) => {
      vi.stubGlobal('fetch', fetchFn)
      const pr = (await handlers.get('reviews.pr')!({ repo: 'o/r', number: 7 })) as ReviewPr
      expect(pr.body).toMatch(local)
      expect(pr.timeline.filter((t) => local.test(t.body))).toHaveLength(forms.length * 2)
      for (const secret of signedImages.secrets) expect(JSON.stringify(pr)).not.toContain(secret)
    },
  )
})
