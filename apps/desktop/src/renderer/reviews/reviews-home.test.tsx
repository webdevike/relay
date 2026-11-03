import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

let rows: (typeof ROW)[] = [ROW, DRAFT]

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
  if (ch === 'reviews.ci') return { ok: true, value: arg?.number === 173 ? 'fail' : 'pass' }
  if (ch === 'reviews.approvable') {
    return { ok: true, value: arg?.number === 173 ? { key: 'ENG-1', state: 'ready' } : null }
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
const openTab = vi.fn()
vi.mock('../tiling/tiling-store', async (orig) => ({
  ...(await orig<typeof TilingStore>()),
  openTab: (...a: unknown[]) => openTab(...a),
}))

import { createTabs, placeOf } from '@evaos/shell-core'
import { tabsStore } from '../tabs/tabs-store'
import { ReviewsPage } from './ReviewsPage'
import { reviewPlaceOf } from './review-place'
import { resetReviewsForTests, reviewsStore } from './reviews-store'

const here = placeOf('reviews')
const wrap = () =>
  render(
    <MantineProvider>
      <ReviewsPage place={here} />
    </MantineProvider>,
  )

beforeEach(() => {
  rows = [ROW, DRAFT]
  invoke.mockClear()
  openPlace.mockClear()
  openTab.mockClear()
  resetReviewsForTests()
  tabsStore.setState(
    { tabs: createTabs([{ id: 0, here, back: [], forward: [], pinned: false }], 0), loaded: true },
    true,
  )
})

describe('Reviews home (nothing selected)', () => {
  it('lists the queue instead of a placeholder, with CI and Approve ready', async () => {
    wrap()
    expect(await screen.findByTestId('review-row-172')).toBeTruthy()
    expect(screen.queryByText(/Pick a pull request/)).toBeNull()
    await waitFor(() => expect(screen.getAllByTestId('review-row-ci')).toHaveLength(2))
    expect(screen.getByText('CI passing')).toBeTruthy()
    expect(screen.getByText('CI failing')).toBeTruthy()
    expect(screen.getAllByTestId('review-row-approve')).toHaveLength(1)
    expect(screen.getByText('Draft')).toBeTruthy()
  })

  it('does not open a PR by itself', async () => {
    wrap()
    await screen.findByTestId('review-row-172')
    expect(reviewsStore.getState().selected).toBeNull()
  })

  it('a click opens in place, Cmd-click a side pane, Cmd+Shift-click a new tab', async () => {
    wrap()
    const row = await screen.findByTestId('review-row-172')
    fireEvent.click(row, { metaKey: true })
    expect(openTab).toHaveBeenLastCalledWith({
      kind: 'page',
      place: reviewPlaceOf({ kind: 'pr', repo: ROW.repo, number: ROW.number }),
    })
    fireEvent.click(row, { metaKey: true, shiftKey: true })
    expect(openPlace).toHaveBeenLastCalledWith(
      reviewPlaceOf({ kind: 'pr', repo: ROW.repo, number: ROW.number }),
      { newTab: true },
    )
    fireEvent.click(row)
    expect(reviewsStore.getState().selected?.number).toBe(172)
  })

  it('shows the empty state only when the queue is empty', async () => {
    rows = []
    wrap()
    expect(await screen.findByTestId('reviews-home-empty')).toBeTruthy()
  })
})
