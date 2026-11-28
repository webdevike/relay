import { describe, expect, it } from 'vitest'
import type { LinearIssue } from '@evaos/contract'
import { TicketBoardFacts, type TicketPrFacts } from '@relay/protocol'
import type { PrFacts } from '../context-popover/gh'
import { parseItem, type Item } from '../context-popover/items'
import {
  DAY_MS,
  DRAG_BLOCK,
  buildBoard,
  keysNamed,
  pickRun,
  placeRun,
  placeSynced,
  placeTicket,
  watchKeys,
  type AutoWork,
  type BoardInput,
  type Run,
  type TicketFacts,
} from './derive'

const NOW = Date.parse('2026-11-09T15:00:00Z')

const item = (stem: string, fm: string, updated = '2026-11-08'): Item =>
  parseItem(stem, `---\nupdated: ${updated}\n${fm}\n---\n`, '/eva', NOW)

const pr = (over: Partial<PrFacts> = {}): PrFacts => ({
  repo: 'o/r',
  number: 254,
  title: 't',
  url: 'https://github.com/o/r/pull/254',
  state: 'OPEN',
  draft: false,
  decision: null,
  base: 'develop',
  head: 'fix',
  additions: 1,
  deletions: 1,
  checks: { passed: 1, failed: 0, pending: 0, total: 1 },
  reviews: [],
  ...over,
})

const run = (over: Partial<Run> = {}): Run => ({
  id: 'helper:/s/x.jsonl',
  kind: 'helper',
  title: 'Helper',
  status: 'working',
  intent: null,
  agent: 'Astra',
  at: NOW - 60_000,
  session: null,
  open: { kind: 'chat', file: '/s/x.jsonl' },
  ...over,
})

const facts = (over: Partial<TicketFacts> = {}): TicketFacts => ({
  key: 'ENG-1',
  item: null,
  watch: null,
  kickoff: null,
  pr: null,
  linear: null,
  run: null,
  unstarted: false,
  ...over,
})

const prFacts = (over: Partial<TicketPrFacts> = {}): TicketPrFacts => ({
  repo: 'o/r',
  number: 7,
  title: 'A PR',
  url: 'https://github.com/o/r/pull/7',
  author: 'dev',
  state: 'open',
  draft: false,
  checks: { state: 'pass', passed: 1, failed: 0, pending: 0 },
  decision: null,
  mergeState: null,
  headSha: 'abc',
  updatedAt: NOW,
  ...over,
})

/** A synced issue as the host's board has it. */
const ticket = (key: string, s: { state?: string; type?: string }): TicketBoardFacts =>
  TicketBoardFacts.parse({
    key,
    id: `issue-${key}`,
    documentContentId: null,
    title: `Ticket ${key}`,
    url: `https://linear.app/x/issue/${key}`,
    state: {
      id: `state-${s.state ?? 'Todo'}`,
      name: s.state ?? 'Todo',
      type: s.type ?? 'unstarted',
      color: '#fff',
    },
    team: { id: 'team-eng', key: 'ENG' },
    priority: 2,
    prioritySortOrder: 1,
    assignee: { id: 'u-isaac', name: 'Isaac', avatarUrl: null },
    creator: null,
    labels: [{ id: 'l', name: 'Bug', color: '#f00' }],
    project: null,
    milestone: null,
    parent: null,
    children: [
      { id: 'c1', key: 'ENG-1', title: 'a', done: true },
      { id: 'c2', key: 'ENG-2', title: 'b', done: false },
    ],
    relations: [],
    prs: [],
    dueDate: null,
    startedAt: null,
    createdAt: NOW - DAY_MS,
    updatedAt: NOW - 60_000,
    subscribed: true,
    prFacts: [],
    attention: { waiting: [], needsYou: null },
  })

describe('placeTicket', () => {
  it('puts a ticket Linear finished in Done, whatever else is true', () => {
    const p = placeTicket(
      facts({
        item: item('ENG-1', 'stage: 9 PR\nmove: isaac'),
        linear: { state: 'Done', stateType: 'completed' },
        run: run(),
      }),
    )
    expect(p.column).toBe('done')
    expect(p.pill.label).toBe('Done')
  })

  it('puts a ticket with a session waiting on Isaac in Needs Isaac, a running one in Working', () => {
    const waiting = placeTicket(
      facts({
        item: item('ENG-1', 'move: eva'),
        run: run({ status: 'waiting', intent: 'Pick a design' }),
      }),
    )
    expect(waiting).toMatchObject({ column: 'needs', reason: 'Pick a design' })
    const working = placeTicket(
      facts({ item: item('ENG-1', 'move: isaac'), watch: { phase: 'pre-review' }, run: run() }),
    )
    expect(working).toMatchObject({ column: 'working', pill: { label: 'Pre-review' } })
  })

  it('counts an auto-work kickoff still running as Working with no run listed', () => {
    const p = placeTicket(facts({ kickoff: { state: 'running', phase: 'intake' } }))
    expect(p).toMatchObject({ column: 'working', pill: { label: 'Intake' } })
  })

  it('asks Isaac when restarts ran out, QA bounced, or the ledger says his move', () => {
    expect(
      placeTicket(
        facts({
          item: item('ENG-1', 'move: eva'),
          kickoff: { state: 'failed', escalatedAt: '2026-11-08T00:00:00Z' },
        }),
      ).pill.label,
    ).toBe('Stuck')
    const bounced = placeTicket(
      facts({
        item: item('ENG-1', 'stage: 11 After merge\nmove: eva'),
        watch: {
          phase: 'post-review',
          bouncedAt: '2026-11-08T00:00:00Z',
          bounceNote: 'Steve: broken',
        },
      }),
    )
    expect(bounced).toMatchObject({
      column: 'needs',
      pill: { label: 'QA bounced' },
      reason: 'Steve: broken',
    })
    const mine = placeTicket(
      facts({ item: item('ENG-1', 'stage: 9 PR\nmove: isaac\nnext: Review draft #253') }),
    )
    expect(mine).toMatchObject({
      column: 'needs',
      pill: { label: 'Review' },
      reason: 'Review draft #253',
    })
  })

  it('puts merged work, post-review and Linear In QA in Merged/QA', () => {
    expect(
      placeTicket(
        facts({ item: item('ENG-1', 'stage: 9 PR\nmove: eva'), pr: pr({ state: 'MERGED' }) }),
      ).column,
    ).toBe('qa')
    expect(
      placeTicket(facts({ item: item('ENG-1', 'move: eva'), watch: { phase: 'post-review' } }))
        .column,
    ).toBe('qa')
    const qa = placeTicket(
      facts({
        item: item('ENG-1', 'stage: 11 After merge\nmove: steve'),
        linear: { state: 'In QA', stateType: 'started' },
      }),
    )
    expect(qa).toMatchObject({ column: 'qa', pill: { label: 'In QA' } })
    expect(
      placeTicket(facts({ item: item('ENG-1', 'stage: 11 After merge\nmove: steve') })).pill.label,
    ).toBe('Waiting on Steve')
  })

  it('puts a ready PR, in-review phase or someone else reviewing in In review', () => {
    expect(
      placeTicket(facts({ item: item('ENG-1', 'stage: 9 PR\nmove: eva'), pr: pr() })).column,
    ).toBe('review')
    const changes = placeTicket(
      facts({ item: item('ENG-1', 'move: eva'), pr: pr({ decision: 'CHANGES_REQUESTED' }) }),
    )
    expect(changes.pill.label).toBe('Changes requested')
    const noah = placeTicket(
      facts({ item: item('ENG-1', 'stage: 10 Review\nmove: noah'), pr: pr({ draft: true }) }),
    )
    expect(noah).toMatchObject({ column: 'review', pill: { label: 'Waiting on Noah' } })
  })

  it("queues the agent's own move with nothing running, and In Progress tickets with no work", () => {
    const draft = placeTicket(
      facts({ item: item('ENG-1', 'stage: 9 PR\nmove: eva'), pr: pr({ draft: true }) }),
    )
    expect(draft).toMatchObject({ column: 'queued', pill: { label: 'Draft PR' } })
    const fresh = placeTicket(facts({ unstarted: true }))
    expect(fresh).toMatchObject({ column: 'queued', pill: { label: 'Not started' } })
  })

  it('calls a ticket with a closed ledger that auto-work stopped watching Done', () => {
    expect(placeTicket(facts({ watch: { phase: 'unwatched' } })).column).toBe('done')
    expect(placeTicket(facts({ watch: { phase: 'in-review' } })).column).toBe('review')
  })
})

describe('runs', () => {
  it('places runs of their own by status', () => {
    expect(placeRun(run()).column).toBe('working')
    expect(placeRun(run({ status: 'waiting' })).column).toBe('needs')
    expect(placeRun(run({ status: 'failed' }))).toMatchObject({
      column: 'done',
      pill: { label: 'Failed' },
    })
    expect(placeRun(run({ status: 'done' })).column).toBe('done')
  })

  it('finds ticket keys in session and helper names', () => {
    const known = new Set(['ENG-6832', 'ENG-6328', 'relay-rooms'])
    expect(keysNamed('ENG-6328 auto-work', known)).toEqual(['ENG-6328'])
    expect(keysNamed('Eng6832QaFixes', known)).toEqual(['ENG-6832'])
    expect(keysNamed('Rooms pass on relay-rooms', known)).toEqual(['relay-rooms'])
    expect(keysNamed('Fix254Review', known)).toEqual([])
  })

  it('picks the run that matters: waiting, working, open, then the latest', () => {
    const done = run({ id: 'a', status: 'done', at: NOW })
    const open = run({ id: 'b', status: 'open', at: NOW - DAY_MS })
    const working = run({ id: 'c', status: 'working', at: NOW - 2 * DAY_MS })
    expect(pickRun([done, open])?.id).toBe('b')
    expect(pickRun([done, open, working])?.id).toBe('c')
    expect(pickRun([])).toBeNull()
  })
})

describe('buildBoard', () => {
  const auto: AutoWork = {
    agent: 'Astra',
    tickets: {
      'ENG-6832': {
        phase: 'pre-review',
        phaseAt: '2026-11-06T20:20:54Z',
        pr: 'https://github.com/o/react/pull/254',
      },
      'ENG-6407': { phase: 'unwatched', phaseAt: '2026-10-31T02:28:31Z' },
      'ENG-5000': { phase: 'unwatched', phaseAt: '2026-11-08T02:28:31Z' },
    },
    started: {
      'ENG-6832': {
        title: 'Fix versions',
        state: 'ended',
        phase: 'pre-review',
        sessionFile: '/s/2026-11-06T20-30-55-007Z_01a1-6832.jsonl',
        url: 'https://linear.app/ecard-systems/issue/ENG-6832/x',
      },
    },
    flagged: ['ENG-6900'],
  }
  const input = (over: Partial<BoardInput> = {}): BoardInput => ({
    now: NOW,
    items: [
      item(
        'ENG-6832',
        'title: [platform-assets] Fix versions\nstage: 9 PR (draft)\nmove: isaac\nnext: OK the draft\nworkspace: ecardsystems\npr: https://github.com/o/api/pull/173\nlinear: https://linear.app/ecard-systems/issue/ENG-6832/x',
      ),
      item(
        'relay-rooms',
        'title: Rooms\nstage: verify\nmove: isaac\nworkspace: eva-interface',
        '2026-10-20',
      ),
    ],
    autoWork: [auto],
    runs: [
      run({
        id: 'helper:/s/Eng6832QaFixes.jsonl',
        title: 'Eng6832QaFixes',
        status: 'done',
        at: NOW - 3_600_000,
      }),
      run({ id: 'helper:/s/Fix254Review.jsonl', title: 'Fix254Review', status: 'working' }),
      run({ id: 'helper:/s/AgentKanban.jsonl', title: 'AgentKanban', status: 'working' }),
      run({ id: 'session:idle', kind: 'session', title: 'Old chat', status: 'open' }),
    ],
    owners: new Map([['relay-rooms', 'Nova']]),
    pr: () => null,
    linear: () => null,
    linearStarted: [],
    tickets: null,
    ...over,
  })

  it("folds a ticket's runs into its card and gives runs of their own a card each", () => {
    const cards = buildBoard(input())
    const ticket = cards.find((c) => c.key === 'ENG-6832')!
    // Fix254Review names the PR auto-work watches (#254), so it is working on this ticket.
    expect(ticket).toMatchObject({ column: 'working', session: 'Fix254Review', agent: 'Astra' })
    // Every run opens something, so both runs on it are links.
    expect(ticket.links.map((l) => l.kind)).toEqual([
      'linear',
      'pr',
      'pr',
      'session',
      'session',
      'ledger',
    ])
    expect(ticket.pr).toMatchObject({ repo: 'o/react', number: 254, state: null })
    const own = cards.filter((c) => c.key === null).map((c) => c.title)
    expect(own).toEqual(['AgentKanban'])
  })

  it('marks old untouched items stale, owners from the registry, and drops old closed tickets', () => {
    const cards = buildBoard(input())
    expect(cards.find((c) => c.key === 'relay-rooms')).toMatchObject({
      stale: true,
      agent: 'Nova',
      column: 'needs',
    })
    expect(cards.find((c) => c.key === 'ENG-6407')).toBeUndefined()
    expect(cards.find((c) => c.key === 'ENG-5000')).toMatchObject({
      column: 'done',
      pill: { label: 'Closed' },
    })
  })

  it('leaves out keys a card cannot carry (a generated _index, a key with spaces)', () => {
    const bad: AutoWork = { agent: 'Astra', tickets: {}, started: {}, flagged: ['ENG 1'] }
    const cards = buildBoard(
      input({ items: [item('_index', 'stage: x')], autoWork: [bad], runs: [] }),
    )
    expect(cards).toEqual([])
  })

  it('queues flagged and Linear In Progress tickets that have no work yet', () => {
    const started: LinearIssue = {
      identifier: 'ENG-7001',
      title: 'New ticket',
      url: 'https://linear.app/x/issue/ENG-7001',
      state: 'In Progress',
      stateType: 'started',
      priority: 'High',
      assignee: 'Isaac',
      project: null,
      updatedAt: NOW - 3_600_000,
    }
    const cards = buildBoard(input({ linearStarted: [started] }))
    expect(cards.find((c) => c.key === 'ENG-7001')).toMatchObject({
      column: 'queued',
      title: 'New ticket',
    })
    expect(cards.find((c) => c.key === 'ENG-6900')).toMatchObject({
      column: 'queued',
      pill: { label: 'Not started' },
    })
  })

  it('asks for PR facts only for cards that are not stale, and reads Linear by key', () => {
    const asked: string[] = []
    const cards = buildBoard(
      input({
        runs: [],
        pr: (repo, n) => {
          asked.push(`${repo}#${n}`)
          return pr({ repo, number: n, state: 'MERGED' })
        },
        linear: (key) =>
          key === 'ENG-6832'
            ? {
                identifier: key,
                title: 't',
                url: 'https://linear.app/x',
                state: 'In Review',
                stateType: 'started',
                priority: 'High',
                assignee: null,
                project: null,
                updatedAt: NOW,
              }
            : null,
      }),
    )
    expect(asked).toEqual(['o/react#254'])
    // Isaac's move wins over a merged PR: the ledger says he has to look.
    expect(cards.find((c) => c.key === 'ENG-6832')).toMatchObject({
      column: 'needs',
      linear: { state: 'In Review' },
    })
  })

  describe('with the host’s synced tickets', () => {
    const synced = (
      tickets: TicketBoardFacts[],
      writes = true,
    ): Pick<BoardInput, 'tickets' | 'linear' | 'linearStarted'> => ({
      tickets: { tickets, writes },
      linear: () => null,
      linearStarted: [],
    })
    const both = synced([
      ticket('ENG-6832', { state: 'Todo', type: 'unstarted' }),
      ticket('ENG-8000', { state: 'In Progress', type: 'started' }),
    ])

    it('makes one card per key: an agent card gets the facts, an issue with no work is a ticket card', () => {
      const cards = buildBoard(input(both))
      expect(cards.filter((c) => c.key === 'ENG-6832')).toHaveLength(1)
      const agent = cards.find((c) => c.key === 'ENG-6832')!
      expect(agent).toMatchObject({
        id: 'item:ENG-6832',
        kind: 'item',
        ticket: { id: 'issue-ENG-6832', state: { name: 'Todo' } },
        linear: { state: 'Todo', stateType: 'unstarted' },
      })
      expect(cards.find((c) => c.key === 'ENG-8000')).toMatchObject({
        id: 'ticket:ENG-8000',
        kind: 'ticket',
        column: 'working',
        title: 'Ticket ENG-8000',
        stale: false,
        ticket: { team: { key: 'ENG' }, sub: { done: 1, total: 2 } },
      })
    })

    it('keeps an agent-driven card in its run’s column and blocks dragging it', () => {
      const agent = buildBoard(input(both)).find((c) => c.key === 'ENG-6832')!
      // Linear says Todo; Fix254Review runs on it, so the column follows the run.
      expect(agent.column).toBe('working')
      expect(agent.dragBlock).toBe('Astra is working on this; the column follows her run')
    })

    it('gives an agent card in Needs its reason as Needs you, unless the host has one', () => {
      const idle = buildBoard(input({ ...both, runs: [] })).find((c) => c.key === 'ENG-6832')!
      expect(idle).toMatchObject({ column: 'needs', dragBlock: null })
      expect(idle.ticket?.needsYou).toMatchObject({
        kind: 'agent',
        text: 'OK the draft',
        action: { kind: 'open' },
      })
      expect(idle.ticket?.needsYou?.evidence).toMatch(/^agent:[0-9a-f]{16}$/)
      const host = ticket('ENG-6832', { state: 'Todo', type: 'unstarted' })
      host.attention.needsYou = {
        kind: 'merge',
        text: 'Merge PR #254',
        action: { kind: 'merge', label: 'Merge', pr: { repo: 'o/react', number: 254 } },
        evidence: 'sha:approved',
      }
      const merge = buildBoard(input({ ...synced([host]), runs: [] })).find(
        (c) => c.key === 'ENG-6832',
      )!
      expect(merge.ticket?.needsYou).toMatchObject({ kind: 'merge', evidence: 'sha:approved' })
    })

    it('carries waiting mentions, PR facts and labels onto the card', () => {
      const t = ticket('ENG-8000', { state: 'In Progress', type: 'started' })
      t.attention.waiting = [
        {
          provider: 'github',
          itemId: 'o/r#9',
          rootId: 'c1',
          commentId: 'c2',
          author: { id: 'u', name: 'Steve', avatarUrl: null },
          at: NOW,
          excerpt: '@isaac look',
          count: 2,
          anchor: {
            kind: 'pr-review-line',
            pr: { repo: 'o/r', number: 9 },
            path: 'a.ts',
            line: 3,
            side: 'RIGHT',
          },
        },
      ]
      t.prFacts = [prFacts({ number: 9, draft: true })]
      const card = buildBoard(input(synced([t]))).find((c) => c.key === 'ENG-8000')!
      expect(card.ticket?.waiting).toMatchObject({
        author: { name: 'Steve' },
        count: 2,
        anchor: { kind: 'pr-review-line', pr: { number: 9 }, path: 'a.ts', side: 'RIGHT' },
      })
      expect(card.ticket?.labels).toEqual([{ name: 'Bug', color: '#f00' }])
      expect(card.ticket?.prs).toEqual([
        expect.objectContaining({ number: 9, state: 'draft', checks: 'pass' }),
      ])
      expect(card.pr).toMatchObject({ number: 9, state: 'draft' })
      // A draft PR doesn't put it in review.
      expect(card.column).toBe('working')
      expect(card.links.map((l) => l.kind)).toEqual(['linear', 'pr'])
    })

    it('watches only the Linear keys on cards the host doesn’t hold', () => {
      expect(watchKeys(buildBoard(input(both)))).toEqual(['ENG-5000'])
      expect(watchKeys(buildBoard(input(synced([])))).sort()).toEqual(['ENG-5000', 'ENG-6832'])
    })

    it('opens tickets, ledger-only items and runs of their own by kind', () => {
      const runs = [
        run({ id: 'helper:k', title: 'AgentKanban' }),
        run({
          id: 's',
          kind: 'session',
          title: 'Chat',
          open: { kind: 'chat', file: '/s/c.jsonl' },
        }),
        run({ id: 'h', kind: 'harness', title: 'Pane', open: { kind: 'jobs' } }),
        run({
          id: 'c',
          kind: 'canvas',
          title: 'Room',
          open: { kind: 'url', url: 'https://x.test' },
        }),
      ]
      const cards = buildBoard(input({ ...both, runs }))
      const target = (pred: (c: (typeof cards)[number]) => boolean) => cards.find(pred)?.openTarget
      expect(target((c) => c.key === 'ENG-6832')).toEqual({ kind: 'ticket', key: 'ENG-6832' })
      expect(target((c) => c.key === 'ENG-8000')).toEqual({ kind: 'ticket', key: 'ENG-8000' })
      expect(target((c) => c.key === 'relay-rooms')).toEqual({ kind: 'item', id: 'relay-rooms' })
      expect(target((c) => c.kind === 'helper')).toEqual({
        kind: 'link',
        open: { kind: 'chat', file: '/s/x.jsonl' },
      })
      expect(target((c) => c.kind === 'session')).toEqual({
        kind: 'link',
        open: { kind: 'chat', file: '/s/c.jsonl' },
      })
      expect(target((c) => c.kind === 'harness')).toEqual({ kind: 'link', open: { kind: 'jobs' } })
      expect(target((c) => c.kind === 'canvas')).toEqual({
        kind: 'link',
        open: { kind: 'url', url: 'https://x.test' },
      })
    })

    it('says why a card can’t be dragged', () => {
      const off = buildBoard(input(synced([ticket('ENG-8000', {})], false)))
      expect(off.find((c) => c.key === 'ENG-8000')?.dragBlock).toBe(DRAG_BLOCK.writesOff)
      expect(off.find((c) => c.key === 'relay-rooms')?.dragBlock).toBe(DRAG_BLOCK.noIssue)
      expect(off.find((c) => c.kind === 'helper')?.dragBlock).toBe(DRAG_BLOCK.noIssue)
      const open = buildBoard(input(both))
      expect(open.find((c) => c.key === 'ENG-8000')?.dragBlock).toBeNull()
      const fallback = buildBoard(input())
      expect(fallback.every((c) => c.dragBlock === DRAG_BLOCK.fallback)).toBe(true)
      expect(fallback.every((c) => c.ticket === null && c.kind !== 'ticket')).toBe(true)
    })

    it('leaves out ticket cards Linear finished more than a week ago', () => {
      const old = ticket('ENG-8001', { state: 'Done', type: 'completed' })
      old.updatedAt = NOW - 8 * DAY_MS
      const fresh = ticket('ENG-8002', { state: 'Done', type: 'completed' })
      const keys = buildBoard(input(synced([old, fresh]))).map((c) => c.key)
      expect(keys).not.toContain('ENG-8001')
      expect(keys).toContain('ENG-8002')
    })
  })
})

describe('placeSynced', () => {
  const place = (name: string, type: string, prs: TicketPrFacts[] = []) => {
    const t = ticket('ENG-1', { state: name, type })
    return placeSynced({ ...t, prFacts: prs }).column
  }

  it('places a synced issue with no agent work by its Linear state', () => {
    expect(place('Done', 'completed')).toBe('done')
    expect(place('Canceled', 'canceled')).toBe('done')
    expect(place('In QA', 'started')).toBe('qa')
    expect(place('In Review', 'started')).toBe('review')
    expect(place('Design Review', 'started')).toBe('needs')
    expect(place('In Progress', 'started')).toBe('working')
    expect(place('Todo', 'unstarted')).toBe('queued')
    expect(place('Backlog', 'backlog')).toBe('queued')
    expect(place('Triage', 'triage')).toBe('queued')
  })

  it('puts an issue with an open, non-draft PR in review', () => {
    expect(place('In Progress', 'started', [prFacts()])).toBe('review')
    expect(place('Todo', 'unstarted', [prFacts({ draft: true })])).toBe('queued')
    expect(place('In Progress', 'started', [prFacts({ state: 'merged' })])).toBe('working')
    expect(place('Done', 'completed', [prFacts()])).toBe('done')
  })
})
