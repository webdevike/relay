import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TilingStore from '../tiling/tiling-store'

const ROW = {
  repo: 'eCardSystems/api',
  number: 172,
  title: 'Fix the thing',
  url: 'https://github.com/eCardSystems/api/pull/172',
  author: 'sam',
  draft: false,
  updatedAt: Date.now(),
}
const DRAFT = { ...ROW, number: 173, title: 'Astra draft', draft: true }
const LOOPING = { ...ROW, number: 174, title: 'Self-reviewing', draft: true }

let rows: (typeof ROW)[] = [ROW, DRAFT, LOOPING]
const TICKET = {
  key: 'ENG-6648',
  title: 'Row borders',
  url: 'https://linear.app/ecard/issue/ENG-6648',
  reason: 'assigned you',
  actor: 'sam',
  updatedAt: Date.now() - 60_000,
  unread: false,
}
let tickets: (typeof TICKET)[] = []
/** What the Mini's ledger says about #173 (the one waiting on Isaac). */
let approveState: 'ready' | 'sent' = 'ready'
/** GitHub's live draft flag for #173 (the queue's cached search row says draft). */
let live173Draft = true

/** The PR read for a row: a local read (no host actions facts). */
const prOf = (number: number) => ({
  repo: ROW.repo,
  number,
  title: number === 173 ? 'Astra draft' : ROW.title,
  url: `https://github.com/${ROW.repo}/pull/${number}`,
  state: 'OPEN',
  draft: number !== 172,
  author: { login: 'sam', avatarUrl: null },
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  body: '',
  base: 'main',
  head: 'fix',
  additions: 1,
  deletions: 0,
  reviewers: [],
  assignees: [],
  labels: [],
  milestone: null,
  projects: [],
  participants: ['sam'],
  commits: [],
  timeline: [],
  checks: [],
  files: [],
  diff: '',
})

/** The PR page's read. */
const prAnswer = (_ch: string, number: number) => ({ ok: true, value: prOf(number) })

const invoke = vi.fn(async (ch: string, arg?: { number?: number; url?: string }) => {
  if (ch === 'reviews.pr') return prAnswer(ch, arg?.number ?? 172)
  if (ch === 'reviews.done') {
    // Done answers the marks: the PR's, or the ticket's when a ticket was done.
    const url = arg?.url ?? prOf(172).url
    return { ok: true, value: { [url]: Date.now() } }
  }
  if (ch === 'reviews.queue') {
    return {
      ok: true,
      value: {
        needs: rows,
        reviewing: [],
        completed: [],
        completedTotal: 0,
        created: [],
        fetchedAt: Date.now(),
        done: {},
      },
    }
  }
  if (ch === 'reviews.linearQueue') return { ok: true, value: tickets }
  if (ch === 'reviews.slackQueue') return { ok: true, value: { rows: [], fetchedAt: Date.now() } }
  if (ch === 'reviews.rowStatus') {
    return {
      ok: true,
      value: {
        draft: arg?.number === 173 ? live173Draft : arg?.number === 174,
        ci: arg?.number === 173 ? 'fail' : 'pass',
        decision: null,
      },
    }
  }
  if (ch === 'reviews.work') {
    if (arg?.number === 173) {
      return {
        ok: true,
        value: {
          key: 'ENG-1',
          stage: '9 PR (draft)',
          move: 'isaac',
          phase: 'pre-review',
          loop: null,
          approve: approveState,
        },
      }
    }
    if (arg?.number === 174) {
      return {
        ok: true,
        value: {
          key: 'ENG-2',
          stage: '9 PR (draft)',
          move: 'isaac',
          phase: 'pre-review',
          loop: { running: true, rounds: 1, outcome: null },
          approve: null,
        },
      }
    }
    return { ok: true, value: null }
  }
  if (ch === 'reviews.approvable') {
    return {
      ok: true,
      value: arg?.number === 173 ? { key: 'ENG-1', state: approveState } : null,
    }
  }
  if (ch === 'reviews.approve') {
    approveState = 'sent'
    return { ok: true, value: { status: 'sent', command: 'x' } }
  }
  return { ok: false, error: { code: 'x', message: 'not in tests' } }
})
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string])),
  on: () => () => {},
}))
const openPlace = vi.fn()
vi.mock('../navigation/navigate', () => ({
  openPlace: (...a: unknown[]) => openPlace(...a),
  setNavigator: () => {},
}))
vi.mock('../navigation/open-link', () => ({ openLink: () => {} }))
const openPlaceBeside = vi.fn()
vi.mock('../tiling/tiling-store', async (orig) => ({
  ...(await orig<typeof TilingStore>()),
  openPlaceBeside: (...a: unknown[]) => openPlaceBeside(...a),
}))

import { createTabs, placeOf } from '@evaos/shell-core'
import { tabsStore } from '../tabs/tabs-store'
import { ticketPlace } from '../tickets/ticket-place'
import { InboxDone } from './InboxDone'
import { ReviewsPage } from './ReviewsPage'
import { reviewPlaceOf } from './review-place'
import { resetReviewsForTests, reviewsStore } from './reviews-store'
import { refreshRowStatus } from './row-status'

const here = placeOf('reviews')
const wrap = () =>
  render(
    <MantineProvider>
      <ReviewsPage place={here} />
    </MantineProvider>,
  )

beforeEach(() => {
  rows = [ROW, DRAFT, LOOPING]
  tickets = []
  approveState = 'ready'
  live173Draft = true
  invoke.mockClear()
  openPlace.mockClear()
  openPlaceBeside.mockClear()
  resetReviewsForTests()
  reviewsStore.setState({ view: 'for-me' })
  tabsStore.setState(
    { tabs: createTabs([{ id: 0, here, back: [], forward: [], pinned: false }], 0), loaded: true },
    true,
  )
})

describe('Reviews home (nothing selected)', () => {
  const status = (n: number) =>
    within(screen.getByTestId(`review-row-${n}`)).getByTestId('review-row-status')

  it('lists the queue instead of a placeholder, a status icon per slot', async () => {
    wrap()
    expect(await screen.findByTestId('review-row-172')).toBeTruthy()
    expect(screen.queryByText(/Pick a pull request/)).toBeNull()
    await waitFor(() => expect(screen.getAllByTestId('review-row-ci')).toHaveLength(3))
    expect(screen.getAllByTestId('review-row-ci').map((m) => m.textContent)).toEqual([
      'CI passing',
      'CI failing',
      'CI passing',
    ])
    await waitFor(() => expect(screen.getAllByTestId('review-row-approve')).toHaveLength(1))
    expect(status(173)).toHaveTextContent('Draft')
    // Four fixed slots on every row, a missing status leaves its slot empty, and no pills.
    for (const n of [172, 173, 174]) {
      expect(status(n).querySelectorAll('.eva-list-status')).toHaveLength(4)
    }
    expect(status(172).querySelectorAll('.eva-list-status:empty')).toHaveLength(3)
    expect(screen.getByTestId('review-row-172').querySelectorAll('.eva-list-pill')).toHaveLength(0)
  })

  it('shows where each auto-work PR stands, from the ledger and the self-review loop', async () => {
    wrap()
    await waitFor(() =>
      expect(
        within(screen.getByTestId('review-row-174')).getByTestId('review-row-work'),
      ).toHaveTextContent('Self-review 1/3'),
    )
  })

  it('moves a row to Approved when the ledger shows the approve was sent, without a reload', async () => {
    wrap()
    await waitFor(() => expect(status(173)).toHaveTextContent('Approve ready'))
    approveState = 'sent'
    await act(async () => refreshRowStatus())
    await waitFor(() => expect(status(173)).toHaveTextContent('Approved'))
    expect(status(173)).not.toHaveTextContent('Approve ready')
  })

  it('drops Draft when GitHub says the PR is ready, whatever the cached queue row says', async () => {
    wrap()
    await waitFor(() => expect(status(173)).toHaveTextContent('Draft'))
    live173Draft = false
    await act(async () => refreshRowStatus())
    await waitFor(() => expect(status(173)).not.toHaveTextContent('Draft'))
    expect(status(173)).toHaveTextContent('Ready for review')
  })

  it('does not open a PR by itself', async () => {
    wrap()
    await screen.findByTestId('review-row-172')
    expect(reviewsStore.getState().selected).toBeNull()
  })

  it('a click opens in place, Cmd-click a background tab, Cmd+Shift-click a split', async () => {
    wrap()
    openPlaceBeside.mockClear()
    const row = await screen.findByTestId('review-row-172')
    fireEvent.click(row, { metaKey: true })
    expect(openPlaceBeside).toHaveBeenLastCalledWith(
      reviewPlaceOf({ kind: 'pr', repo: ROW.repo, number: ROW.number }),
    )
    fireEvent.click(row, { metaKey: true, shiftKey: true })
    expect(openPlaceBeside).toHaveBeenCalledTimes(2)
    expect(openPlace).not.toHaveBeenCalled()
    fireEvent.click(row)
    expect(reviewsStore.getState().selected?.number).toBe(172)
  })

  it('shows the empty state only when the queue is empty', async () => {
    rows = []
    wrap()
    expect(await screen.findByTestId('reviews-home-empty')).toBeTruthy()
  })
})

describe('Reviews page with a pull request picked', () => {
  it('shows the PR page (Guide, Diff, Comments and the sidebar); Done marks it handled', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('review-row-172'))
    expect(await screen.findByTestId('review-detail')).toBeInTheDocument()
    for (const t of ['guide', 'diff', 'comments']) {
      expect(screen.getByTestId(`review-tab-${t}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('review-rail')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('review-done'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reviews.done', {
        url: prOf(172).url,
        updatedAt: expect.any(Number),
        done: true,
      }),
    )
    await waitFor(() => expect(reviewsStore.getState().selected?.number).not.toBe(172))
  })

  it('keeps Approve on an auto-work draft, sent straight to Astra', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('review-row-173'))
    fireEvent.click(await screen.findByTestId('review-approve'))
    await waitFor(() => expect(screen.getByTestId('review-approve')).toHaveTextContent('Approved'))
  })
})

describe('Reviews page with a Linear ticket', () => {
  beforeEach(() => {
    tickets = [TICKET]
  })

  it('opens the ticket page (the Board’s) instead of a Reviews ticket view', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('review-ticket-ENG-6648'))
    expect(openPlace).toHaveBeenLastCalledWith(ticketPlace('ENG-6648'), { newTab: false })
    expect(reviewsStore.getState().selected).toBeNull()
    // The Reviews page itself still lists the queue.
    expect(screen.getByTestId('review-row-172')).toBeInTheDocument()
  })

  it('Done in the ticket page header is the row’s Done: same reviews.done, row held back', async () => {
    wrap()
    await screen.findByTestId('review-ticket-ENG-6648')
    render(
      <MantineProvider>
        <InboxDone ticketKey="ENG-6648" title={TICKET.title} />
      </MantineProvider>,
    )
    fireEvent.click(await screen.findByTestId('review-done'))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reviews.done', {
        url: TICKET.url,
        updatedAt: expect.any(Number),
        done: true,
      }),
    )
    await waitFor(() => expect(screen.queryByTestId('review-ticket-ENG-6648')).toBeNull())
    expect(screen.queryByTestId('review-done')).toBeNull()
  })
})
