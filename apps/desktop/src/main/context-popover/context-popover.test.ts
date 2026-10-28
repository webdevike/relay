import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createConfigStore } from '../config-store'
import { createWriteQueue } from '../write-queue'
import { BackgroundCache } from './bg-cache'
import { parsePr } from './gh'
import { canCommitPush, parseShortstat, parseStatus, type GitFacts } from './git'
import type { JobSummary } from '@evaos/eva-core/model/jobs-read'
import type { RelaySession } from '../relay/feed'
import { itemFinished, itemReady, parseItem } from './items'
import { PinStore } from './pins'
import { LineCache } from './sessions'
import { buildSnapshot, itemAt, itemOwners, prPill, shortLogin } from './snapshot'

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

describe('tasks', () => {
  const NOW = Date.parse('2026-10-28T17:00:00')
  const item = (stem: string, fm: string) =>
    parseItem(stem, `---\n${fm}\n---\n`, '/eva', NOW - 3_600_000)
  const job = (name: string, runState: JobSummary['runState'], lastRunAt: number): JobSummary => ({
    name,
    description: `${name} job`,
    every: null,
    enabled: true,
    scheduled: false,
    maxRun: null,
    keep: null,
    lastRunAt,
    runState,
    runStateRaw: null,
    runNote: null,
    sessionFile: null,
    nextDueAt: null,
    hasScript: true,
  })
  const relay = (id: string, extra: Partial<RelaySession>): RelaySession => ({
    id,
    status: 'idle',
    detail: null,
    canRespond: true,
    kind: 'manual',
    title: '',
    assistant: null,
    activity: null,
    activityAt: null,
    ...extra,
  })
  const snapshot = (sessions: RelaySession[]) =>
    buildSnapshot(
      {
        evaRoot: '/nonexistent-eva',
        now: () => NOW,
        items: () => [
          item(
            'ENG-1',
            'title: Row borders\nstage: 9 PR (draft)\nmove: isaac\nnext: Review draft #12\npr: https://github.com/o/r/pull/12\nupdated: 2026-10-28',
          ),
          item(
            'relay-rooms',
            'title: Rooms\nstage: 3 Plan\nmove: Isaac\nnext: Say which gate stays\nupdated: 2026-10-27',
          ),
          item('ENG-2', 'title: Sort icon\nstage: 10 Review\nmove: noah\nupdated: 2026-10-28'),
          item('ENG-3', 'title: Shipped\nstage: 11 After merge\nmove: isaac\nupdated: 2026-10-28'),
        ],
        lines: new LineCache(),
        pins: () => [],
        placeOf: () => null,
        assistants: () => [],
        relaySessions: () => new Map(sessions.map((s) => [s.id, s])),
        sessionFile: (id) => `/s/2026-10-28T10-00-00-000Z_${id}.jsonl`,
        pr: () => null,
        git: () => null,
        jobs: () => [
          job('furry-drop', 'running', NOW - 120_000),
          job('sweep', 'ok', NOW - 3_600_000),
          job('backup', 'failed', NOW - 7_200_000),
        ],
        experiments: async () => [],
      },
      { file: null, agent: null, scope: 'everywhere', open: true },
    )

  it('tells a review stage from a question', () => {
    expect(
      ['9 PR (draft)', '7 Verify', 'verify', '10 Review'].map((stage) => itemReady({ stage })),
    ).toEqual([true, true, true, true])
    expect(['3 Plan', 'discover', null].map((stage) => itemReady({ stage }))).toEqual([
      false,
      false,
      false,
    ])
  })

  it('groups everything by what it needs from Isaac, Resolved folded', async () => {
    const snap = await snapshot([
      relay('q1', {
        status: 'waiting',
        title: 'Fix login',
        activity: 'Ship it today?',
        activityAt: NOW - 60_000,
      }),
      relay('p1', { status: 'needs_permission', kind: 'job', title: 'furry-drop', detail: 'bash' }),
      relay('w1', { status: 'working', title: 'Busy chat' }),
    ])
    expect(snap.sections.map((s) => [s.id, s.title, s.fold])).toEqual([
      ['needs', 'Needs input', false],
      ['review', 'Ready for review', false],
      ['working', 'Working', false],
      ['resolved', 'Resolved', true],
    ])
    const [needs, review, working, resolved] = snap.sections
    expect(needs!.rows.map((r) => [r.title, r.sub])).toEqual([
      ['Fix login', 'Ship it today?'],
      ['furry-drop', 'Approve bash'],
      ['Rooms', 'Say which gate stays'],
    ])
    expect(needs!.rows[0]!.open).toEqual({
      kind: 'chat',
      file: '/s/2026-10-28T10-00-00-000Z_q1.jsonl',
    })
    expect(needs!.rows[0]!.time).toEqual({ at: NOW - 60_000, style: 'elapsed' })
    // Built work opens its PR; someone else's move and finished stages are not Isaac's tasks.
    expect(review!.rows.map((r) => [r.title, r.sub, r.icon, r.open])).toEqual([
      [
        'Row borders',
        'ENG-1: Review draft #12',
        'ready',
        { kind: 'url', url: 'https://github.com/o/r/pull/12' },
      ],
    ])
    expect(review!.rows[0]!.time?.style).toBe('day')
    expect(working!.rows.map((r) => r.title)).toEqual(['furry-drop'])
    // Finished work is quiet; only a failure keeps its color.
    expect(resolved!.rows.map((r) => [r.title, r.tone])).toEqual([
      ['sweep', 'default'],
      ['backup failed', 'danger'],
    ])
    expect(snap.button).toMatchObject({
      label: '1 running',
      dot: 'needs',
      summary: 'Everywhere: 1 working, 3 need input, 1 ready for review',
    })
  })

  it('names what waits for a look on the button when nothing runs or blocks', async () => {
    const snap = await buildSnapshot(
      {
        evaRoot: '/nonexistent-eva',
        now: () => NOW,
        items: () => [
          item('ENG-1', 'title: Row borders\nstage: verify\nmove: isaac\nupdated: 2026-10-28'),
        ],
        lines: new LineCache(),
        pins: () => [],
        placeOf: () => null,
        assistants: () => [],
        relaySessions: () => null,
        sessionFile: () => null,
        pr: () => null,
        git: () => null,
        jobs: () => [],
        experiments: async () => [],
      },
      { file: null, agent: null, scope: 'everywhere', open: false },
    )
    expect(snap.sections.map((s) => s.id)).toEqual(['review'])
    expect(snap.button).toMatchObject({ label: '1 to review', dot: null })
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
