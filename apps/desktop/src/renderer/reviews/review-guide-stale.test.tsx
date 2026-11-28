// A Guide read at other commits than the page shows makes the page reload the PR once. When that
// reload fails the page keeps its PR (no new `pr` prop), so the Guide must stop waiting on its own:
// an error with Retry, not a spinner. Covered through both pages that show a PR.
import { MantineProvider } from '@mantine/core'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from '@relay/protocol/fixtures/review-guide.json'
import type * as TilingStore from '../tiling/tiling-store'

const ROW = {
  repo: 'eCardSystems/api',
  number: 172,
  title: 'Lock edits after 30 minutes',
  url: 'https://github.com/eCardSystems/api/pull/172',
  author: 'sam',
  draft: false,
  updatedAt: Date.now(),
}
const PR = {
  repo: ROW.repo,
  number: ROW.number,
  title: ROW.title,
  url: ROW.url,
  state: 'OPEN',
  draft: false,
  author: { login: 'sam', avatarUrl: null },
  createdAt: Date.now(),
  updatedAt: Date.now(),
  body: '',
  base: 'main',
  head: 'lock',
  headSha: 'a'.repeat(40),
  baseSha: 'c'.repeat(40),
  additions: 1,
  deletions: 0,
  reviewers: [],
  assignees: [],
  labels: [],
  milestone: null,
  projects: [],
  participants: [],
  commits: [],
  timeline: [],
  checks: [],
  files: fixture.input.files.map((f) => ({ ...f, change: 'MODIFIED' })),
  diff: fixture.input.diff,
}

/** What `reviews.pr` answers, call by call (the last one repeats). */
let prAnswers: boolean[] = []
let guideMoved = true
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
  if (ch === 'reviews.linearQueue') return { ok: true, value: [] }
  if (ch === 'reviews.slackQueue') return { ok: true, value: { rows: [], fetchedAt: Date.now() } }
  if (ch === 'reviews.pr') {
    const ok = prAnswers.length > 1 ? prAnswers.shift()! : (prAnswers[0] ?? false)
    return ok
      ? { ok: true, value: { ...PR, updatedAt: Date.now() } }
      : { ok: false, error: { code: 'not-connected', message: 'Relay Host is not connected' } }
  }
  if (ch === 'reviews.guide') {
    return guideMoved
      ? { ok: false, error: { code: 'x', message: 'PR changed; regenerating' } }
      : { ok: true, value: fixture.expected }
  }
  return { ok: false, error: { code: 'x', message: 'not in tests' } }
})
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string])),
  on: () => () => {},
}))
vi.mock('../navigation/navigate', () => ({ openPlace: () => {}, setNavigator: () => {} }))
vi.mock('../navigation/open-link', () => ({ openLink: () => {} }))
vi.mock('../tiling/tiling-store', async (orig) => ({
  ...(await orig<typeof TilingStore>()),
  openPlaceBeside: () => {},
}))

import { createTabs, placeOf, type Place } from '@evaos/shell-core'
import { tabsStore } from '../tabs/tabs-store'
import { ReviewPage } from './ReviewPage'
import { ReviewsPage } from './ReviewsPage'
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
const prCalls = (): number => invoke.mock.calls.filter(([ch]) => ch === 'reviews.pr').length

beforeEach(() => {
  invoke.mockClear()
  resetReviewsForTests()
  reviewsStore.setState({ view: 'for-me' })
  // The first read works; the reload after the stale Guide fails (a host gone, gh failing).
  prAnswers = [true, false]
  guideMoved = true
})

/** Opens the Guide tab, then checks the failed reload ends in an error with Retry, and Retry recovers. */
async function staleGuideThenFailedReload(): Promise<void> {
  fireEvent.click(await screen.findByTestId('review-tab-guide'))
  const error = await screen.findByTestId('review-guide-error')
  expect(error.textContent).toContain("reloading it didn't work")
  expect(screen.queryByTestId('review-guide-loading')).toBeNull()
  expect(prCalls()).toBe(2)
  // The page kept its PR: no second Guide read happened without a new PR.
  expect(invoke.mock.calls.filter(([ch]) => ch === 'reviews.guide')).toHaveLength(1)
  // Retry reloads; this time the PR comes and the Guide for it shows.
  prAnswers = [true]
  guideMoved = false
  fireEvent.click(within(error).getByText('Retry'))
  expect(await screen.findAllByTestId('review-guide-section')).toHaveLength(4)
  await waitFor(() => expect(prCalls()).toBe(3))
}

describe('a stale Guide whose PR reload fails', () => {
  it('on the Reviews page: error with Retry, no spinner', async () => {
    const here = placeOf('reviews')
    seed(here)
    render(
      <MantineProvider>
        <ReviewsPage place={here} />
      </MantineProvider>,
    )
    fireEvent.click(await screen.findByTestId('review-row-172'))
    await staleGuideThenFailedReload()
  })

  it("on the PR's own page: error with Retry, no spinner", async () => {
    const place = reviewPlaceOf({ kind: 'pr', repo: ROW.repo, number: ROW.number })
    seed(place)
    render(
      <MantineProvider>
        <ReviewPage place={place} />
      </MantineProvider>,
    )
    await staleGuideThenFailedReload()
  })
})
