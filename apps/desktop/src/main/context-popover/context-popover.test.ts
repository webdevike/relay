import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createConfigStore } from '../config-store'
import { createWriteQueue } from '../write-queue'
import { BackgroundCache } from './bg-cache'
import { parsePr } from './gh'
import { canCommitPush, parseShortstat, parseStatus, type GitFacts } from './git'
import { itemFinished, parseItem } from './items'
import { PinStore } from './pins'
import { itemAt, itemOwners, prPill, shortLogin } from './snapshot'

const PR = JSON.stringify({
  number: 236,
  title: 'fix: Border every page link row',
  url: 'https://github.com/o/r/pull/236',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'CHANGES_REQUESTED',
  baseRefName: 'develop',
  headRefName: 'fix/x',
  additions: 147,
  deletions: 11,
  statusCheckRollup: [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', state: 'FAILURE' },
  ],
  latestReviews: [
    {
      author: { login: 'noahchampoux-ecardsystems' },
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-10-27T20:29:25Z',
    },
    { author: { login: 'todd' }, state: 'PENDING', submittedAt: null },
  ],
})

describe('gh pr facts', () => {
  it('counts checks and keeps reviews that say something', () => {
    const pr = parsePr('o/r', PR)!
    expect(pr.checks).toEqual({ passed: 1, failed: 1, pending: 1, total: 3 })
    expect(pr.reviews.map((r) => r.login)).toEqual(['noahchampoux-ecardsystems'])
    expect(prPill(pr)).toEqual({ label: 'Changes requested', tone: 'warning' })
    expect(prPill({ ...pr, decision: null, draft: true })?.label).toBe('Draft')
    expect(shortLogin('noahchampoux-ecardsystems')).toBe('noahchampoux')
  })

  it('answers null for anything else', () => {
    expect(parsePr('o/r', 'not json')).toBeNull()
    expect(parsePr('o/r', '{"number":1}')).toBeNull()
  })
})

describe('git facts', () => {
  const base: GitFacts = {
    branch: 'fix/x',
    upstream: 'origin/fix/x',
    ahead: 0,
    behind: 0,
    dirty: 0,
    conflicted: false,
    busy: false,
    diff: null,
  }

  it('reads porcelain v2 and shortstat', () => {
    const s = parseStatus(
      '# branch.oid abc\n# branch.head fix/x\n# branch.upstream origin/fix/x\n# branch.ab +2 -1\n1 .M N... a\n? b\nu UU N... c\n',
    )
    expect(s).toEqual({
      branch: 'fix/x',
      upstream: 'origin/fix/x',
      ahead: 2,
      behind: 1,
      dirty: 3,
      conflicted: true,
    })
    expect(parseStatus('# branch.head (detached)\n').branch).toBeNull()
    expect(parseShortstat(' 8 files changed, 147 insertions(+), 11 deletions(-)')).toEqual({
      add: 147,
      del: 11,
    })
  })

  it('offers Commit & push only when it is safe', () => {
    expect(canCommitPush(base, true)).toBe(false)
    expect(canCommitPush({ ...base, dirty: 2 }, true)).toBe(true)
    expect(canCommitPush({ ...base, ahead: 1 }, null)).toBe(true)
    expect(canCommitPush({ ...base, dirty: 2, behind: 1 }, true)).toBe(false)
    expect(canCommitPush({ ...base, dirty: 2, busy: true }, true)).toBe(false)
    expect(canCommitPush({ ...base, dirty: 2, branch: 'develop' }, true)).toBe(false)
    expect(canCommitPush({ ...base, dirty: 2 }, false)).toBe(false)
  })
})

describe('work items', () => {
  const root = '/eva'
  const item = (stem: string, fm: string) => parseItem(stem, `---\n${fm}\n---\n`, root, 0)

  it('parses a ledger and finds the item a chat is on', () => {
    const i = item(
      'ENG-6524',
      'key: ENG-6524\ntitle: [FE] Row borders\nstage: 9 PR\nmove: Isaac\nworkspace: ecardsystems\nworktree: work/app-ENG-6524\npr: https://github.com/o/r/pull/236\nupdated: 2026-10-27',
    )
    expect(i).toMatchObject({
      title: 'Row borders',
      move: 'isaac',
      worktree: '/eva/work/app-ENG-6524',
    })
    expect(i.pr).toEqual({ repo: 'o/r', number: 236, url: 'https://github.com/o/r/pull/236' })
    const place = {
      cwd: '/eva',
      active: '/eva/work/app-ENG-6524',
      activeBranch: null,
      cwdBranch: null,
      eva: true,
    }
    expect(itemAt([i], place, null)?.key).toBe('ENG-6524')
    expect(itemAt([i], { ...place, active: null }, 'ENG-6524 auto-work')?.key).toBe('ENG-6524')
    expect(itemAt([i], { ...place, active: null }, 'other')).toBeNull()
    expect(itemFinished({ stage: '11 After merge' })).toBe(true)
    expect(itemFinished({ stage: '9 PR' })).toBe(false)
  })

  it('gives an item to the assistant whose scope names its workspace, else whose notes name it', () => {
    const a = item('ENG-1', 'workspace: ecardsystems\nmove: isaac')
    const b = item('relay-rooms', 'workspace: eva-interface\nmove: isaac')
    const owners = itemOwners(
      [a, b],
      [
        { id: 'astra', scope: 'eCard Systems work', notes: '' },
        { id: 'polaris', scope: 'Experiments', notes: 'see relay-rooms soon' },
      ],
    )
    expect(owners.get('ENG-1')).toBe('astra')
    expect(owners.get('relay-rooms')).toBe('polaris')
  })
})

describe('pins', () => {
  it('persist in the config dir, once each, in pin order', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpop-pins-'))
    const store = new PinStore(createConfigStore(dir), createWriteQueue())
    await store.pin({ kind: 'pr', repo: 'o/r', number: 236 })
    await store.pin({ kind: 'item', key: 'ENG-1' })
    await store.pin({ kind: 'pr', repo: 'o/r', number: 236 })
    // A second store over the same dir is the app after a restart.
    const again = new PinStore(createConfigStore(dir), createWriteQueue())
    expect(again.list()).toEqual([
      { kind: 'pr', repo: 'o/r', number: 236 },
      { kind: 'item', key: 'ENG-1' },
    ])
    expect(await again.unpin('pr:o/r#236')).toEqual([{ kind: 'item', key: 'ENG-1' }])
    fs.writeFileSync(
      path.join(dir, 'context-pins.json'),
      '{"pins":[{"kind":"pr"},{"kind":"job","name":"x"}]}',
    )
    expect(again.list()).toEqual([{ kind: 'job', name: 'x' }])
  })
})

describe('background cache', () => {
  it('never waits, fetches once per key while due, and reports changes', async () => {
    let now = 0
    let changes = 0
    let calls = 0
    const cache = new BackgroundCache<{ v: number }>({
      onChange: () => changes++,
      now: () => now,
      hotMs: 10,
      coldMs: 100,
      backoffMs: 50,
    })
    const fetch = async () => ({ v: ++calls })
    expect(cache.get('k', false, fetch)).toBeNull()
    expect(cache.get('k', false, fetch)).toBeNull()
    await cache.idle()
    expect(calls).toBe(1)
    expect(cache.get('k', false, fetch)).toEqual({ v: 1 })
    now = 20
    cache.get('k', true, fetch)
    await cache.idle()
    expect(cache.get('k', false, fetch)).toEqual({ v: 2 })
    expect(changes).toBe(2)
    now = 200
    cache.get('k', false, async () => null)
    await cache.idle()
    expect(cache.get('k', false, fetch)).toEqual({ v: 2 })
  })
})
