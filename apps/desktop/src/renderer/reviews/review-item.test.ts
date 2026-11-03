import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => undefined }))

import { openReviewItem, resetReviewsForTests, reviewItemOf, reviewsStore } from './reviews-store'

beforeEach(() => resetReviewsForTests())

describe('Reviews item links', () => {
  it('reads a pull request, a Linear issue and a Slack message', () => {
    expect(reviewItemOf('https://github.com/eCardSystems/api/pull/170/files')).toMatchObject({
      kind: 'pr',
      row: {
        repo: 'eCardSystems/api',
        number: 170,
        url: 'https://github.com/eCardSystems/api/pull/170',
      },
    })
    expect(reviewItemOf('https://linear.app/ecard/issue/eng-5974/fix-it')).toMatchObject({
      kind: 'linear',
      row: { key: 'ENG-5974' },
    })
    expect(
      reviewItemOf(
        'https://ecard.slack.com/archives/C0CB9NMQDHB/p1793223274330049?thread_ts=1793223000.000100',
      ),
    ).toMatchObject({
      kind: 'slack',
      row: { channel: 'C0CB9NMQDHB', ts: '1793223274.330049', threadTs: '1793223000.000100' },
    })
    expect(reviewItemOf('https://ecard.slack.com/archives/D01/p1793223274330049')).toMatchObject({
      row: { kind: 'dm', threadTs: null },
    })
    expect(reviewItemOf('https://example.com/pull/1')).toBeNull()
    expect(reviewItemOf('not a link')).toBeNull()
  })

  it('opens the queue’s own row when it lists the item, one item at a time', () => {
    const row = {
      repo: 'o/r',
      number: 3,
      title: 'Real title',
      url: 'u',
      author: 'a',
      draft: false,
      updatedAt: 9,
    }
    reviewsStore.setState({
      queue: {
        needs: [row],
        reviewing: [],
        completed: [],
        completedTotal: 0,
        created: [],
        done: {},
        fetchedAt: 0,
      },
    })
    expect(openReviewItem('https://github.com/o/r/pull/3')).toBe(true)
    expect(reviewsStore.getState()).toMatchObject({
      selected: row,
      ticket: null,
      thread: null,
    })
    expect(openReviewItem('https://linear.app/w/issue/ENG-1')).toBe(true)
    expect(reviewsStore.getState()).toMatchObject({ selected: null, ticket: { key: 'ENG-1' } })
    expect(openReviewItem('https://example.com')).toBe(false)
  })
})
