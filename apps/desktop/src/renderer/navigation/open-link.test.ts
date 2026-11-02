import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LINK_PREFS } from '@evaos/contract'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: vi.fn() }))
vi.mock('../tiling/tiling-store', () => ({ revealTool: vi.fn() }))

import { linkPrefsStore } from './link-prefs'
import { openLink } from './open-link'

beforeEach(() => {
  invoke.mockReset()
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
    openLink('https://linear.app/w/issue/ENG-1')
    openLink('https://github.com/o/r/pull/2')
    expect(invoke.mock.calls).toEqual([
      ['links.open', { url: 'https://linear.app/w/issue/ENG-1' }],
      ['links.open', { url: 'https://github.com/o/r/pull/2' }],
    ])
  })
  it('opens an app link here when the app is missing, and ignores other schemes', () => {
    linkPrefsStore.setState({ apps: [] })
    openLink('https://github.com/o')
    openLink('mailto:x@y.z')
    expect(invoke.mock.calls).toEqual([['browser.createTab', { url: 'https://github.com/o' }]])
  })
})
