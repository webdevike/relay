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
const TICKET = {
  key: 'ENG-6648',
  title: 'Row borders',
  url: 'https://linear.app/ecard/issue/ENG-6648',
  reason: 'assigned you',
  actor: 'sam',
  updatedAt: Date.now(),
  unread: false,
}
const THREAD = {
  kind: 'reply',
  channel: 'C0123',
  channelName: '#ui-ux',
  threadTs: '1793389459.456979',
  ts: '1793389459.456979',
  author: 'sam',
  text: 'hello there',
  url: 'https://x.slack.com/archives/C0123/p1793389459456979',
  updatedAt: Date.now(),
}

const invoke = vi.fn(async (ch: string) => {
  if (ch === 'reviews.queue') {
    return {
      ok: true,
      value: {
        needs: [ROW],
        reviewing: [],
        completed: [],
        completedTotal: 0,
        created: [],
        fetchedAt: Date.now(),
        done: {},
      },
    }
  }
  if (ch === 'reviews.linearQueue') return { ok: true, value: [TICKET] }
  if (ch === 'reviews.slackQueue') {
    return { ok: true, value: { rows: [THREAD], fetchedAt: Date.now() } }
  }
  if (ch === 'reviews.pr') return { ok: false, error: { code: 'x', message: 'no gh in tests' } }
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
const openLink = vi.fn()
vi.mock('../navigation/open-link', () => ({ openLink: (...a: unknown[]) => openLink(...a) }))
const openPlaceBeside = vi.fn()
vi.mock('../tiling/tiling-store', async (orig) => ({
  ...(await orig<typeof TilingStore>()),
  openPlaceBeside: (...a: unknown[]) => openPlaceBeside(...a),
}))

import { createTabs, placeOf, type Place } from '@evaos/shell-core'
import { tabsStore } from '../tabs/tabs-store'
import { ReviewPage } from './ReviewPage'
import { ReviewsList } from './ReviewsList'
import { reviewPlaceOf } from './review-place'
import { resetReviewsForTests, reviewsStore } from './reviews-store'

const seed = (here: Place): void =>
  tabsStore.setState(
    {
      tabs: createTabs([{ id: 0, here, back: [], forward: [], pinned: false }], 0),
      loaded: true,
    },
    true,
  )
const wrap = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>)

const PR_PLACE = reviewPlaceOf({ kind: 'pr', repo: ROW.repo, number: ROW.number })
const TICKET_PLACE = reviewPlaceOf({ kind: 'linear', key: TICKET.key })
const THREAD_PLACE = reviewPlaceOf({
  kind: 'slack',
  channel: THREAD.channel,
  threadTs: THREAD.threadTs,
})

beforeEach(() => {
  invoke.mockClear()
  openPlace.mockClear()
  openLink.mockClear()
  openPlaceBeside.mockClear()
  resetReviewsForTests()
  reviewsStore.setState({ view: 'for-me' })
  seed(placeOf('reviews'))
})

describe('queue rows open review places', () => {
  it('a plain click on the Reviews page selects in place, as before', async () => {
    wrap(<ReviewsList />)
    fireEvent.click(await screen.findByTestId('review-row-172'))
    expect(reviewsStore.getState().selected?.number).toBe(172)
    expect(openPlace).not.toHaveBeenCalled()
  })

  it('a plain click elsewhere goes to the item’s own place in this tab, like a chat or board', async () => {
    seed(placeOf('dashboard'))
    wrap(<ReviewsList />)
    fireEvent.click(await screen.findByTestId('review-row-172'))
    expect(openPlace).toHaveBeenLastCalledWith(PR_PLACE, { newTab: false })
    expect(reviewsStore.getState().selected).toBeNull()
  })

  it('Cmd-click and middle-click open a background tab, Cmd+Shift-click a split', async () => {
    wrap(<ReviewsList />)
    openPlaceBeside.mockClear()
    const pr = await screen.findByTestId('review-row-172')
    fireEvent.click(pr, { metaKey: true })
    expect(openPlaceBeside).toHaveBeenLastCalledWith(PR_PLACE)
    fireEvent.click(pr, { metaKey: true, shiftKey: true })
    expect(openPlaceBeside).toHaveBeenCalledTimes(2)
    fireEvent(pr, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(openPlaceBeside).toHaveBeenCalledTimes(3)
    const ticket = await screen.findByTestId('review-ticket-ENG-6648')
    fireEvent.click(ticket, { metaKey: true, shiftKey: true })
    expect(openPlaceBeside).toHaveBeenLastCalledWith(TICKET_PLACE)
    const thread = await screen.findByTestId('review-slack-row')
    fireEvent(thread, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    expect(openPlaceBeside).toHaveBeenLastCalledWith(THREAD_PLACE)
    // None of these leave the workspace's own tab, and the page's selection never moved.
    expect(openPlace).not.toHaveBeenCalled()
    expect(reviewsStore.getState().selected).toBeNull()
    // A right-button auxclick is not a middle-click.
    fireEvent(pr, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }))
    expect(openPlaceBeside).toHaveBeenCalledTimes(5)
  })

  it('the context menu offers a new tab, a split pane and the browser', async () => {
    wrap(<ReviewsList />)
    fireEvent.contextMenu(await screen.findByTestId('review-row-172'))
    fireEvent.click(await screen.findByTestId('review-row-menu-tab'))
    expect(openPlace).toHaveBeenLastCalledWith(PR_PLACE, { newTab: true })
    fireEvent.contextMenu(await screen.findByTestId('review-ticket-ENG-6648'))
    fireEvent.click(await screen.findByTestId('review-row-menu-split'))
    expect(openPlaceBeside).toHaveBeenLastCalledWith(TICKET_PLACE)
    fireEvent.contextMenu(await screen.findByTestId('review-row-172'))
    fireEvent.click(await screen.findByTestId('review-row-menu-link'))
    expect(openLink).toHaveBeenLastCalledWith(ROW.url, { reviews: false })
  })

  it('marks the row of the review tab that is open', async () => {
    seed(PR_PLACE)
    wrap(<ReviewsList />)
    await waitFor(() =>
      expect(screen.getByTestId('review-row-172')).toHaveAttribute('data-active', 'true'),
    )
  })
})

describe('ReviewPage', () => {
  it('shows a queued ticket and a Slack thread from the place alone', async () => {
    seed(TICKET_PLACE)
    const t = wrap(<ReviewPage place={TICKET_PLACE} />)
    await screen.findByTestId('review-place')
    await waitFor(() =>
      expect(screen.getByTestId('review-place')).toHaveAttribute('data-review', 'linear:ENG-6648'),
    )
    t.unmount()
    wrap(<ReviewPage place={THREAD_PLACE} />)
    expect(await screen.findByTestId('review-place')).toBeInTheDocument()
  })

  it('loads the pull request itself, not the page selection, and says when it cannot', async () => {
    seed(PR_PLACE)
    wrap(<ReviewPage place={PR_PLACE} />)
    expect(
      await screen.findByText("Couldn't load the pull request: no gh in tests"),
    ).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('reviews.pr', { repo: ROW.repo, number: 172 })
    expect(reviewsStore.getState().selected).toBeNull()
  })

  it('refuses an id the app did not make', () => {
    const odd = placeOf('review:other:1')
    wrap(<ReviewPage place={odd} />)
    expect(screen.getByTestId('review-place-unknown')).toBeInTheDocument()
  })
})
