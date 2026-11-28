import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentCard, ReviewPr } from '@evaos/contract'
import type { TicketDetail, TicketPrFacts } from '@relay/protocol'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { cardOf, ticketOf, waitingFrom } from '../agents-board/test-cards'
import type { TicketPr } from '../agents-board/ticket-prs'
import { applyUiPrefs, flushUiPrefs } from '../ui-prefs'
import { prSignalsOf, prSignalsOfReview, prStatusOf } from './pr-status'
import { StatusStrip } from './StatusStrip'
import { fromLinearTicket, setSidebarOpen, ticketsUiStore, type TicketData } from './ticket-data'
import { parseTicketPlace } from './ticket-place'

const facts = (repo: string, number: number, over: Partial<TicketPrFacts> = {}): TicketPrFacts => ({
  repo,
  number,
  title: `${repo}#${number}`,
  url: `https://github.com/${repo}/pull/${number}`,
  author: 'isaac',
  state: 'open',
  draft: false,
  checks: { state: 'pass', passed: 3, failed: 0, pending: 0 },
  decision: 'APPROVED',
  mergeState: 'CLEAN',
  headSha: 'abc',
  updatedAt: 1,
  ...over,
})

const pr = (repo: string, number: number): TicketPr => ({
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  title: null,
  state: 'open',
  via: 'linear',
})

function detailWith(prFacts: TicketPrFacts[]): TicketDetail {
  const base = fromLinearTicket({
    id: 'issue-1',
    key: 'ENG-1',
    title: 'T',
    url: 'u',
    description: '',
    creator: 'c',
    createdAt: 1,
    updatedAt: 1,
    state: { name: 'In Review', type: 'started', color: '#0f0' },
    assignee: null,
    priority: 'None',
    labels: [],
    project: null,
    team: 'ENG',
    parent: null,
    children: [],
    links: [],
    comments: [],
    people: [],
    me: { name: 'Isaac', handle: 'isaac', url: 'u' },
  })
  return { ...base, prFacts }
}

const dataOf = (detail: TicketDetail | null): TicketData => ({
  key: 'ENG-1',
  detail,
  source: 'host',
  unavailable: null,
  writeMode: 'none',
  me: { linearViewerId: null, name: null },
  refresh: () => {},
})

function strip(
  detail: TicketDetail | null,
  prs: TicketPr[],
  page = 'ticket:ENG-1',
  card: AgentCard | null = null,
) {
  const go = vi.fn()
  render(
    <MantineProvider>
      <StatusStrip
        at={parseTicketPlace(page)!}
        data={dataOf(detail)}
        card={card}
        prs={prs}
        go={go}
      />
    </MantineProvider>,
  )
  return go
}

afterEach(() => invoke.mockReset())

describe('prStatusOf', () => {
  it('names the first blocker in the order Isaac fixes them', () => {
    const s = (f: TicketPrFacts) => prStatusOf(prSignalsOf(pr(f.repo, f.number), [f], null))
    expect(s(facts('a/b', 1))).toMatchObject({
      line: 'Ready to merge',
      tone: 'ok',
      checks: '3/3 checks passing',
      conflicts: 'No conflicts',
    })
    expect(s(facts('a/b', 1, { draft: true })).line).toBe('Blocked: Draft')
    expect(s(facts('a/b', 1, { mergeState: 'DIRTY' })).line).toBe('Blocked: Conflicts')
    expect(
      s(facts('a/b', 1, { checks: { state: 'fail', passed: 1, failed: 2, pending: 0 } })).line,
    ).toBe('Blocked: 2 failing checks')
    expect(s(facts('a/b', 1, { decision: 'CHANGES_REQUESTED' })).line).toBe(
      'Blocked: Changes requested',
    )
    expect(s(facts('a/b', 1, { state: 'merged' }))).toMatchObject({
      line: 'Merged',
      conflicts: null,
    })
  })

  it("reads the synced card's facts without host PR facts, and claims nothing without any", () => {
    const card = cardOf({
      key: 'ENG-1',
      ticket: ticketOf({
        prs: [
          {
            repo: 'a/b',
            number: 1,
            url: 'u',
            title: 't',
            state: 'open',
            checks: 'fail',
            decision: null,
          },
        ],
      }),
    })
    expect(prStatusOf(prSignalsOf(pr('a/b', 1), [], card))).toMatchObject({
      line: 'Blocked: Failing checks',
      checks: 'Checks failing',
      conflicts: null,
    })
    expect(prStatusOf(prSignalsOf(pr('a/b', 2), [], null))).toMatchObject({
      line: 'Open',
      tone: 'dim',
      checks: 'Checks unknown',
    })
  })
})

describe('StatusStrip', () => {
  it("shows the ticket's state, the primary PR's status and who waits", () => {
    const card = cardOf({
      key: 'ENG-1',
      ticket: ticketOf({ waiting: waitingFrom('Chris Doe', 'c-7') }),
    })
    const go = strip(
      detailWith([facts('acme/app', 5, { mergeState: 'DIRTY' })]),
      [pr('acme/app', 5)],
      'ticket:ENG-1',
      card,
    )
    expect(screen.getByTestId('ticket-strip-state').textContent).toBe('In Review')
    expect(screen.getByTestId('ticket-strip-pr').textContent).toBe('app#5')
    expect(screen.getByTestId('ticket-strip-line').textContent).toBe('Blocked: Conflicts')
    expect(screen.getByTestId('ticket-strip-checks').textContent).toBe('3/3 checks passing')
    expect(screen.getByTestId('ticket-strip-conflicts').textContent).toBe(
      'Conflicts with the base branch',
    )
    expect(screen.queryByTestId('ticket-strip-stepper')).toBeNull()
    screen.getByTestId('ticket-strip-waiting').click()
    expect(go).toHaveBeenCalledWith(expect.objectContaining({ page: 'ticket:ENG-1#comment-c-7' }))
  })

  it('steps across same-number PRs in two repos by repo#number', async () => {
    const d = detailWith([
      facts('acme/app', 5),
      facts('acme/web', 5, { checks: { state: 'fail', passed: 0, failed: 1, pending: 0 } }),
    ])
    strip(d, [pr('acme/app', 5), pr('acme/web', 5)])
    expect(screen.getByTestId('ticket-strip-pos').textContent).toBe('1 of 2')
    expect(screen.getByTestId('ticket-strip-pr').textContent).toBe('app#5')
    expect(screen.getByTestId('ticket-strip-line').textContent).toBe('Ready to merge')
    await userEvent.click(screen.getByTestId('ticket-strip-next'))
    expect(screen.getByTestId('ticket-strip-pos').textContent).toBe('2 of 2')
    expect(screen.getByTestId('ticket-strip-pr').textContent).toBe('web#5')
    expect(screen.getByTestId('ticket-strip-line').textContent).toBe('Blocked: 1 failing check')
    expect(screen.getByTestId('ticket-strip-next')).toBeDisabled()
  })

  it("on a PR's page shows that PR and steps to the next PR's page", async () => {
    const go = strip(
      detailWith([]),
      [pr('acme/app', 5), pr('acme/web', 5)],
      'ticket:ENG-1/pr/acme/web/5',
    )
    expect(screen.getByTestId('ticket-strip-pos').textContent).toBe('2 of 2')
    await userEvent.click(screen.getByTestId('ticket-strip-prev'))
    expect(go).toHaveBeenCalledWith(expect.objectContaining({ page: 'ticket:ENG-1/pr/acme/app/5' }))
  })

  it("on a PR's page says what the PR's sidebar says, from the same read", () => {
    const blocked = facts('acme/app', 5, { decision: 'REVIEW_REQUIRED', mergeState: 'BLOCKED' })
    // The PR page's read of the same PR: GitHub's BLOCKED, no review yet.
    const read = {
      repo: 'acme/app',
      number: 5,
      state: 'OPEN',
      draft: false,
      reviewers: [],
      checks: [{ name: 'ci', state: 'pass', url: null }],
      actions: { mergeStateStatus: 'BLOCKED', reviews: [], checks: [] },
    } as unknown as ReviewPr
    const sidebar = prStatusOf(prSignalsOfReview(read)).line
    const page = 'ticket:ENG-1/pr/acme/app/5'
    const at = parseTicketPlace(page)!
    const view = (r: ReviewPr | null) => (
      <MantineProvider>
        <StatusStrip
          at={at}
          data={dataOf(detailWith([blocked]))}
          card={null}
          prs={[pr('acme/app', 5)]}
          go={vi.fn()}
          read={r}
        />
      </MantineProvider>
    )
    const { rerender } = render(view(null))
    // Before the page's read lands: the ticket's facts.
    expect(screen.getByTestId('ticket-strip-line').textContent).toBe('Blocked: Waiting on review')
    rerender(view(read))
    expect(screen.getByTestId('ticket-strip-line').textContent).toBe(sidebar)
    expect(sidebar).toBe('Blocked: Required reviews or checks are missing')
    // Another PR's read is not this one's.
    rerender(view({ ...read, repo: 'acme/web' }))
    expect(screen.getByTestId('ticket-strip-line').textContent).toBe('Blocked: Waiting on review')
  })
})

describe('the sidebar fold', () => {
  it('restores from layout.json and saves a change', async () => {
    vi.useFakeTimers()
    invoke.mockResolvedValue({ ok: true, value: null })
    applyUiPrefs({ 'tickets.sidebar': false })
    expect(ticketsUiStore.getState().sidebar).toBe(false)
    setSidebarOpen(true)
    flushUiPrefs()
    expect(invoke).toHaveBeenCalledWith('layout.save', { ui: { 'tickets.sidebar': true } })
    vi.useRealTimers()
  })
})
