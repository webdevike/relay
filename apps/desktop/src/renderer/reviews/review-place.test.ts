import { describe, expect, it } from 'vitest'
import { pageFromKey, placeFromJson, placeOf, placeToJson } from '@evaos/shell-core'
import { setReviewTitle } from '../eva/names-store'
import { pageMeta } from '../pages/page-meta'
import { tabIconName, tabTitle } from '../tabs/tab-meta'
import {
  reviewFallbackTitle,
  reviewIdOf,
  reviewPlaceOf,
  reviewRefOf,
  reviewRefOfPlace,
  reviewTitleOf,
} from './review-place'
import type { ReviewItem } from './reviews-store'

const PR: ReviewItem = {
  kind: 'pr',
  row: {
    repo: 'eCardSystems/node-client-api-service',
    number: 172,
    title: 'Fix the thing',
    url: 'https://github.com/eCardSystems/node-client-api-service/pull/172',
    author: 'sam',
    draft: false,
    updatedAt: 1,
  },
}
const LINEAR: ReviewItem = {
  kind: 'linear',
  row: {
    key: 'ENG-6648',
    title: 'Row borders',
    url: 'https://linear.app/ecard/issue/ENG-6648',
    reason: 'assigned you',
    actor: 'sam',
    updatedAt: 1,
    unread: false,
  },
}
const SLACK: ReviewItem = {
  kind: 'slack',
  row: {
    kind: 'reply',
    channel: 'C0123',
    channelName: '#ui-ux',
    threadTs: '1793389459.456979',
    ts: '1793389459.456979',
    author: 'sam',
    text: 'hi',
    url: 'https://x.slack.com/archives/C0123/p1793389459456979',
    updatedAt: 1,
  },
}
const DM: ReviewItem = {
  kind: 'slack',
  row: { ...SLACK.row, kind: 'dm', channel: 'D1', threadTs: null } as never,
}

describe('review places', () => {
  it('gives every item its own place key and reads it back', () => {
    for (const item of [PR, LINEAR, SLACK, DM]) {
      const place = reviewPlaceOf(reviewRefOf(item))
      expect(place.page).toBe(`review:${reviewIdOf(reviewRefOf(item))}`)
      expect(pageFromKey(place.page)).toBe(place.page)
      expect(reviewRefOfPlace(place)).toEqual(reviewRefOf(item))
      expect(placeFromJson(placeToJson(place))).toEqual(place)
    }
    expect(reviewPlaceOf(reviewRefOf(PR)).page).toBe(
      'review:pr:eCardSystems/node-client-api-service#172',
    )
    expect(reviewPlaceOf(reviewRefOf(LINEAR)).page).toBe('review:linear:ENG-6648')
    expect(reviewPlaceOf(reviewRefOf(DM)).page).toBe('review:slack:D1:')
  })

  it('refuses ids the app does not make', () => {
    expect(reviewRefOfPlace(placeOf('reviews'))).toBeNull()
    expect(reviewRefOfPlace(placeOf('review:pr:nope'))).toBeNull()
    expect(reviewRefOfPlace(placeOf('review:other:1'))).toBeNull()
  })

  it('names the tab by the item, with a fallback before it was read, and an icon per source', () => {
    expect(reviewTitleOf(PR)).toBe('#172 Fix the thing')
    expect(reviewTitleOf(LINEAR)).toBe('ENG-6648 Row borders')
    expect(reviewTitleOf(SLACK)).toBe('#ui-ux thread')
    expect(reviewTitleOf(DM)).toBe('#ui-ux')
    const pr = reviewPlaceOf(reviewRefOf(PR))
    expect(tabTitle(pr)).toBe('node-client-api-service#172')
    expect(reviewFallbackTitle('linear:ENG-6648')).toBe('ENG-6648')
    setReviewTitle(reviewIdOf(reviewRefOf(PR)), reviewTitleOf(PR))
    expect(tabTitle(pr)).toBe('#172 Fix the thing')
    expect(pageMeta(pr)).toMatchObject({ kind: 'review', title: '#172 Fix the thing' })
    expect(tabIconName(pr)).toBe('IconGitPullRequest')
    expect(tabIconName(reviewPlaceOf(reviewRefOf(LINEAR)))).toBe('IconTicket')
    expect(tabIconName(reviewPlaceOf(reviewRefOf(SLACK)))).toBe('IconBrandSlack')
  })

  it('stores titles across reloads', () => {
    setReviewTitle('pr:a/b#1', 'Kept')
    expect(JSON.parse(localStorage.getItem('eva-review-titles') ?? '{}')).toMatchObject({
      'pr:a/b#1': 'Kept',
    })
  })
})
