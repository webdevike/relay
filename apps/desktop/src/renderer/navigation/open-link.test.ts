import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LINK_PREFS } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: vi.fn() }))
const tiling = { focus: 'chat' }
const splitAt = vi.fn()
const openTab = vi.fn()
vi.mock('../tiling/tiling-store', () => ({
  revealTool: vi.fn(),
  splitAt: (...a: unknown[]) => splitAt(...a),
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
  it('opens an item in Reviews: the focused tab, a tool pane, or with Cmd a new pane', () => {
    const reviews = placeOf('reviews')
    openLink('https://linear.app/w/issue/ENG-6693')
    expect(navigateTo).toHaveBeenCalledWith(reviews)
    tiling.focus = 'tools-1'
    openLink('https://github.com/o/r/pull/2')
    expect(openTab).toHaveBeenCalledWith({ kind: 'page', place: reviews }, 'tools-1')
    openLink('https://ecard.slack.com/archives/C1ABC/p1730000000123456', { newPane: true })
    expect(splitAt).toHaveBeenCalledWith('tools-1', 'right', { kind: 'page', place: reviews })
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
  it('opens relay:// links as in-app places, never in a browser', () => {
    openLink('relay://assistant/nova')
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('agent:nova'), { newTab: false })
    openLink('relay://assistant/astra', { newPane: true })
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('agent:astra'), { newTab: true })
    openLink('relay://open/jobs')
    expect(openPlace).toHaveBeenLastCalledWith(placeOf('jobs'), { newTab: false })
    expect(openPlace).toHaveBeenCalledTimes(3)
    // Unknown pages and malformed links go nowhere.
    openLink('relay://open/nope')
    openLink('relay://assistant/')
    openLink('relay://assistant/Nova')
    expect(openPlace).toHaveBeenCalledTimes(3)
    expect(invoke).not.toHaveBeenCalled()
  })
})
