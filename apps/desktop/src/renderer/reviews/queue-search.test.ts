import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearRow, ReviewRow, SlackRow } from '@evaos/contract'

vi.mock('../ipc', () => ({ invoke: vi.fn(), on: () => () => undefined }))

import {
  itemId,
  itemLinkOf,
  linearMatches,
  openLabel,
  prMatches,
  queryWords,
  sidebarTitle,
  slackMatches,
} from './queue-search'
import { resetReviewsForTests, reviewItemOf, reviewsStore } from './reviews-store'

describe('sidebarTitle', () => {
  it('leads with the ticket key and drops the commit prefix', () => {
    expect(sidebarTitle('feat(ui): ENG-6688 sort picker required')).toBe(
      'ENG-6688 sort picker required',
    )
    expect(sidebarTitle('ENG-6688: sort picker required')).toBe('ENG-6688 sort picker required')
    expect(sidebarTitle('[ENG-6688] sort picker required')).toBe('ENG-6688 sort picker required')
    expect(sidebarTitle('sort picker required (ENG-6688)')).toBe('ENG-6688 sort picker required')
    expect(sidebarTitle('fix: ref ENG-6688 Make the eGift sort picker required')).toBe(
      'ENG-6688 Make the eGift sort picker required',
    )
  })
  it('keeps a title with no key, minus a commit prefix', () => {
    expect(sidebarTitle('Partner external ids')).toBe('Partner external ids')
    expect(sidebarTitle('fix: partner ids')).toBe('partner ids')
    expect(sidebarTitle('ENG-1')).toBe('ENG-1')
  })
})
beforeEach(() => resetReviewsForTests())

const pr: ReviewRow = {
  repo: 'eCardSystems/api',
  number: 246,
  title: 'Partner external ids',
  url: 'https://github.com/eCardSystems/api/pull/246',
  author: 'mara',
  draft: false,
  updatedAt: 0,
}
const ticket: LinearRow = {
  key: 'ENG-6693',
  title: 'Reviews search',
  url: 'https://linear.app/ecard/issue/ENG-6693/reviews-search',
  reason: 'assigned',
  actor: 'Theo',
  updatedAt: 0,
  unread: false,
}
const message: SlackRow = {
  kind: 'reply',
  channel: 'C1ABC',
  channelName: 'ui-ux',
  threadTs: '1730000000.123456',
  ts: '1730000000.123456',
  author: 'Jen',
  text: 'the rail spacing',
  url: 'https://ecard.slack.com/archives/C1ABC/p1730000000123456',
  updatedAt: 0,
}

describe('queue search', () => {
  it('reads a bare key or owner/repo#n as its link, anything else as itself', () => {
    expect(itemLinkOf(' eng-6693 ')).toBe('https://linear.app/issue/ENG-6693')
    expect(itemLinkOf('eCardSystems/api#246')).toBe('https://github.com/eCardSystems/api/pull/246')
    expect(itemLinkOf('rail spacing')).toBe('rail spacing')
  })
  it('matches every word against title, ids, people and channel', () => {
    expect(prMatches(pr, queryWords('#246'))).toBe(true)
    expect(prMatches(pr, queryWords('api#246 mara'))).toBe(true)
    expect(prMatches(pr, queryWords('partner theo'))).toBe(false)
    expect(linearMatches(ticket, queryWords('eng-6693'))).toBe(true)
    expect(linearMatches(ticket, queryWords('theo search'))).toBe(true)
    expect(slackMatches(message, queryWords('ui-ux jen'))).toBe(true)
  })
  it('opens a typed key the queue lacks, in the queued tickets’ workspace', () => {
    reviewsStore.setState({ linear: { rows: [ticket], error: null } } as never)
    const item = reviewItemOf('ENG-6689')
    expect(item).toMatchObject({
      kind: 'linear',
      row: { key: 'ENG-6689', url: 'https://linear.app/ecard/issue/ENG-6689' },
    })
    expect(openLabel(item!)).toBe('Open ENG-6689')
    expect(itemId(reviewItemOf('ENG-6693')!)).toBe('linear:ENG-6693')
    expect(openLabel(reviewItemOf('eCardSystems/web#12')!)).toBe('Open PR web#12')
    expect(openLabel(reviewItemOf(message.url)!)).toBe('Open Slack thread')
  })
})
