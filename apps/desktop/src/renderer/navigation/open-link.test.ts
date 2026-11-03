import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LINK_PREFS } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: vi.fn() }))
const tiling = { focus: 'chat' }
const openTab = vi.fn()
vi.mock('../tiling/tiling-store', () => ({
  revealTool: vi.fn(),
  openTab: (...a: unknown[]) => openTab(...a),
  tilingStore: { getState: () => ({ tiling }) },
}))
const navigateTo = vi.fn()
vi.mock('../tabs/tabs-store', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }))
const openReviewItem = vi.fn()
vi.mock('../reviews/reviews-store', () => ({
  openReviewItem: (...a: unknown[]) => openReviewItem(...a),
}))
const openPlace = vi.fn()
vi.mock('./navigate', () => ({ openPlace: (...a: unknown[]) => openPlace(...a) }))

import { linkPrefsStore } from './link-prefs'
import { openLink } from './open-link'
import { openFromNav, openInApp } from './open-in-app'
import { navTargetOf, openTargetOf } from './open-target'

beforeEach(() => {
  vi.clearAllMocks()
  tiling.focus = 'chat'
  linkPrefsStore.setState({
    prefs: DEFAULT_LINK_PREFS,
    apps: ['Arc', 'Linear', 'Slack'],
    loaded: true,
  })
})

describe('openLink', () => {
  it('opens unmatched links in a side-browser tab', () => {
    openLink('https://example.com/a')
    expect(invoke).toHaveBeenCalledWith('browser.createTab', { url: 'https://example.com/a' })
  })
  it('hands app links to main', () => {
    openLink('https://linear.app/w/view/all')
    openLink('https://github.com/o/r/pull/2', { reviews: false })
    expect(invoke.mock.calls).toEqual([
      ['links.open', { url: 'https://linear.app/w/view/all' }],
      ['links.open', { url: 'https://github.com/o/r/pull/2', reviews: false }],
    ])
  })
  it('opens an item in Reviews: split by default, Cmd a new tab, Option here', () => {
    const reviews = placeOf('reviews')
    openLink('https://linear.app/w/issue/ENG-6693')
    expect(openTab).toHaveBeenLastCalledWith({ kind: 'page', place: reviews })
    openLink('https://github.com/o/r/pull/2', { target: 'here' })
    expect(navigateTo).toHaveBeenLastCalledWith(reviews)
    openLink('https://ecard.slack.com/archives/C1ABC/p1730000000123456', { target: 'tab' })
    expect(navigateTo).toHaveBeenLastCalledWith(reviews, { newTab: true })
    expect(openReviewItem.mock.calls.map((c) => c[0])).toEqual([
      'https://linear.app/w/issue/ENG-6693',
      'https://github.com/o/r/pull/2',
      'https://ecard.slack.com/archives/C1ABC/p1730000000123456',
    ])
    expect(invoke).not.toHaveBeenCalled()
  })
  it('opens an app link here when the app is missing, and ignores other schemes', () => {
    linkPrefsStore.setState({ apps: [] })
    openLink('https://github.com/o')
    openLink('mailto:x@y.z')
    expect(invoke.mock.calls).toEqual([['browser.createTab', { url: 'https://github.com/o' }]])
  })
  it('opens relay:// links as in-app places beside the chat, never in a browser', () => {
    openLink('relay://assistant/nova')
    expect(openTab).toHaveBeenLastCalledWith({ kind: 'page', place: placeOf('agent:nova') })
    openLink('relay://assistant/astra', { target: 'tab' })
    expect(navigateTo).toHaveBeenLastCalledWith(placeOf('agent:astra'), { newTab: true })
    openLink('relay://open/jobs', { target: 'here' })
    expect(navigateTo).toHaveBeenLastCalledWith(placeOf('jobs'))
    expect(openTab).toHaveBeenCalledTimes(1)
    expect(navigateTo).toHaveBeenCalledTimes(2)
    // Unknown pages and malformed links go nowhere.
    openLink('relay://open/nope')
    openLink('relay://assistant/')
    openLink('relay://assistant/Nova')
    expect(openTab).toHaveBeenCalledTimes(1)
    expect(navigateTo).toHaveBeenCalledTimes(2)
    expect(invoke).not.toHaveBeenCalled()
  })
  it('a chat place cannot split: it gets a new tab', () => {
    openInApp(placeOf('chat', { chat: '/s/a.jsonl' }))
    expect(openTab).not.toHaveBeenCalled()
    expect(navigateTo).toHaveBeenCalledWith(placeOf('chat', { chat: '/s/a.jsonl' }), {
      newTab: true,
    })
  })
  it('Option replaces what the focused pane shows', () => {
    openInApp(placeOf('jobs'), 'here')
    expect(navigateTo).toHaveBeenLastCalledWith(placeOf('jobs'))
    tiling.focus = 'tools-1'
    openInApp(placeOf('jobs'), 'here')
    expect(openTab).toHaveBeenLastCalledWith({ kind: 'page', place: placeOf('jobs') }, 'tools-1')
  })
})

describe('click targets', () => {
  it('in a chat: split by default and with Cmd, Cmd+Shift or middle a new tab, Option here', () => {
    expect(openTargetOf({})).toBe('split')
    expect(openTargetOf({ metaKey: true })).toBe('split')
    expect(openTargetOf({ metaKey: true, shiftKey: true })).toBe('tab')
    expect(openTargetOf({ button: 1 })).toBe('tab')
    expect(openTargetOf({ altKey: true })).toBe('here')
  })
  it('on navigation: this tab by default, Cmd a split, Cmd+Shift or middle a new tab', () => {
    expect(navTargetOf({})).toBe('here')
    expect(navTargetOf({ metaKey: true })).toBe('split')
    expect(navTargetOf({ ctrlKey: true })).toBe('split')
    expect(navTargetOf({ metaKey: true, shiftKey: true })).toBe('tab')
    expect(navTargetOf({ button: 1 })).toBe('tab')
  })
  it('openFromNav: Cmd splits beside, plain and Cmd+Shift go through openPlace', () => {
    openFromNav(placeOf('jobs'), {})
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('jobs'), { newTab: false })
    openFromNav(placeOf('jobs'), { metaKey: true, shiftKey: true })
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('jobs'), { newTab: true })
    expect(openTab).not.toHaveBeenCalled()
    openFromNav(placeOf('jobs'), { metaKey: true })
    expect(openTab).toHaveBeenLastCalledWith({ kind: 'page', place: placeOf('jobs') })
    expect(openPlace).toHaveBeenCalledTimes(2)
  })
  it('Cmd keeps an app override: a Linear link still opens the app, not a pane', () => {
    openLink('https://linear.app/w/view/all', { target: openTargetOf({ metaKey: true }) })
    expect(invoke).toHaveBeenLastCalledWith('links.open', { url: 'https://linear.app/w/view/all' })
    expect(openTab).not.toHaveBeenCalled()
  })
})
