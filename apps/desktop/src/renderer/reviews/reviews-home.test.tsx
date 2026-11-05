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
/** What the Mini's ledger says about #173 (the one waiting on Isaac). */
let approveState: 'ready' | 'sent' = 'ready'
/** GitHub's live draft flag for #173 (the queue's cached search row says draft). */
let live173Draft = true

const invoke = vi.fn(async (ch: string, arg?: { number?: number }) => {
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
  if (ch === 'reviews.linearQueue') return { ok: true, value: [] }
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
