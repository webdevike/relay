import { describe, expect, it } from 'vitest'
import type { LinearIssue } from '@evaos/contract'
import type { PrFacts } from '../context-popover/gh'
import { parseItem, type Item } from '../context-popover/items'
import {
  DAY_MS,
  buildBoard,
  keysNamed,
  pickRun,
  placeRun,
  placeTicket,
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
  open: null,
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
    ...over,
  })

  it("folds a ticket's runs into its card and gives runs of their own a card each", () => {
    const cards = buildBoard(input())
    const ticket = cards.find((c) => c.key === 'ENG-6832')!
    // Fix254Review names the PR auto-work watches (#254), so it is working on this ticket.
    expect(ticket).toMatchObject({ column: 'working', session: 'Fix254Review', agent: 'Astra' })
    expect(ticket.links.map((l) => l.kind)).toEqual(['linear', 'pr', 'pr', 'ledger'])
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
})
