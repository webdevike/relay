import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LINK_PREFS } from '@evaos/contract'
import { pageTab, placeOf } from '@evaos/shell-core'

const { show } = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('@mantine/notifications', () => ({ notifications: { show } }))
const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: vi.fn() }))
const tiling = vi.hoisted(() => ({
  revealTool: vi.fn(),
  openPlaceBeside: vi.fn(),
  splitAt: vi.fn(),
  activateTab: vi.fn(),
  focusPaneById: vi.fn(),
  openArmTab: vi.fn(),
  snapshots: [] as unknown[],
  focus: 'p1' as string | null,
}))
vi.mock('../tiling/tiling-store', () => ({
  revealTool: tiling.revealTool,
  openPlaceBeside: tiling.openPlaceBeside,
  splitAt: tiling.splitAt,
  activateTab: tiling.activateTab,
  focusPaneById: tiling.focusPaneById,
  openArmTab: tiling.openArmTab,
  paneSnapshot: () => tiling.snapshots.shift() ?? { panes: [], focus: tiling.focus, zoom: null },
  tilingStore: { getState: () => ({ focus: tiling.focus }) },
}))
const openWebPage = vi.fn().mockResolvedValue({ pane: 'p2', tab: 'web:1', tabId: '1' })
vi.mock('../tiling/web-tabs', () => ({ openWebPage: (...a: unknown[]) => openWebPage(...a) }))
const navigateTo = vi.fn()
vi.mock('../tabs/tabs-store', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }))
const openReviewItem = vi.fn()
vi.mock('../reviews/reviews-store', () => ({
  openReviewItem: (...a: unknown[]) => openReviewItem(...a),
}))
const showPath = vi.fn().mockResolvedValue({})
vi.mock('../files/files-store', () => ({ showPath: (...a: unknown[]) => showPath(...a) }))
vi.mock('../chat/chat-store', () => ({ chatStore: { getState: () => ({ panes: {} }) } }))
vi.mock('../chat/front-chat', () => ({ frontChatPaneOf: () => '' }))
const requestStudioOpen = vi.fn()
vi.mock('../studio/studio-store', () => ({
  requestStudioOpen: (...a: unknown[]) => requestStudioOpen(...a),
}))
const openPlace = vi.fn()
vi.mock('./navigate', () => ({ openPlace: (...a: unknown[]) => openPlace(...a) }))

import { linkPrefsStore } from './link-prefs'
import { openAppLink, openLink } from './open-link'
import { takeSkillRequest } from '../skills/skill-request'
import { openFromNav, openInApp } from './open-in-app'

beforeEach(() => {
  vi.clearAllMocks()
  tiling.snapshots = []
  tiling.focus = 'p1'
  linkPrefsStore.setState({
    prefs: DEFAULT_LINK_PREFS,
    apps: ['Arc', 'Linear', 'Slack'],
    loaded: true,
  })
})

describe('openLink: web links', () => {
  it('opens a page tab in this workspace: plain here, Cmd background, Cmd+Shift a split', () => {
    openLink('https://example.com/a')
    expect(openWebPage).toHaveBeenLastCalledWith({ url: 'https://example.com/a' })
    openLink('https://example.com/a', { target: 'background' })
    expect(openWebPage).toHaveBeenLastCalledWith({ url: 'https://example.com/a', background: true })
    openLink('https://example.com/a', { target: 'split' })
    expect(openWebPage).toHaveBeenLastCalledWith({ url: 'https://example.com/a', split: 'right' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('Option opens http(s) in Arc through main, and nothing else', () => {
    openLink('https://example.com/x', { target: 'external' })
    expect(invoke).toHaveBeenCalledWith('links.openInArc', { url: 'https://example.com/x' })
    invoke.mockClear()
    openLink('mailto:a@b.c', { target: 'external' })
    openLink('file:///etc/passwd', { target: 'external' })
    expect(invoke).not.toHaveBeenCalled()
    expect(openWebPage).not.toHaveBeenCalled()
  })

  it('keeps app overrides (Linear) going through main', () => {
    openLink('https://linear.app/w/project/x')
    expect(invoke).toHaveBeenCalledWith('links.open', { url: 'https://linear.app/w/project/x' })
    expect(openWebPage).not.toHaveBeenCalled()
  })

  it('opens a Reviews item in Reviews per the target', () => {
    openLink('https://github.com/o/r/pull/1', { target: 'split' })
    expect(tiling.splitAt).toHaveBeenCalledWith('p1', 'right', pageTab(placeOf('reviews')))
    expect(openReviewItem).toHaveBeenCalledWith('https://github.com/o/r/pull/1')
  })

  it('ignores other schemes', () => {
    openLink('javascript:alert(1)')
    expect(invoke).not.toHaveBeenCalled()
    expect(openWebPage).not.toHaveBeenCalled()
  })
})

describe('openAppLink: relay:// addresses', () => {
  it('opens old forms as places beside the chat', () => {
    expect(openAppLink('relay://open/settings/connections?connect=github')).toBe(true)
    expect(tiling.openPlaceBeside).toHaveBeenCalledWith(
      placeOf('settings', { settingsSection: 'Connections' }),
    )
    expect(openAppLink('relay://assistant/nova')).toBe(true)
    expect(tiling.openPlaceBeside).toHaveBeenLastCalledWith(placeOf('agent:nova'))
    expect(openAppLink('relay://open/setting')).toBe(true)
    expect(openAppLink('relay://open/nope')).toBe(false)
  })

  it('opens a chat, a web page, a file, a board and a Studio job', () => {
    openAppLink('relay://open/chat?chat=%2Fs%2Fa.jsonl')
    expect(tiling.openPlaceBeside).toHaveBeenLastCalledWith(placeOf('chat', { chat: '/s/a.jsonl' }))
    openAppLink('relay://open/web?url=https%3A%2F%2Fexample.com', 'background')
    expect(openWebPage).toHaveBeenLastCalledWith({ url: 'https://example.com', background: true })
    openAppLink('relay://open/files?path=work%2Fa.ts&line=12')
    expect(tiling.revealTool).toHaveBeenCalledWith('files')
    expect(showPath).toHaveBeenCalledWith('work/a.ts', null, { line: 12 })
    openAppLink('relay://open/canvas?canvas=mind-map', 'split')
    expect(tiling.splitAt).toHaveBeenLastCalledWith(
      'p1',
      'right',
      pageTab(placeOf('canvas', { canvas: 'mind-map' })),
    )
    openAppLink('relay://open/studio?job=j1')
    expect(requestStudioOpen).toHaveBeenCalledWith({ job: 'j1' })
  })

  it('opens a review id as its own place', () => {
    openAppLink('relay://open/reviews?item=linear%3AENG-1')
    expect(tiling.openPlaceBeside).toHaveBeenLastCalledWith(placeOf('review:linear:ENG-1'))
    expect(openReviewItem).not.toHaveBeenCalled()
  })

  it('opens a skill in the Skills page and hands it the name', () => {
    takeSkillRequest()
    openAppLink('relay://open/skills?skill=canvas')
    expect(tiling.openPlaceBeside).toHaveBeenLastCalledWith(placeOf('skills'))
    expect(takeSkillRequest()).toBe('canvas')
    // The param only counts on the Skills page.
    openAppLink('relay://open/jobs?skill=canvas')
    expect(takeSkillRequest()).toBeNull()
  })

  it('a pasted link with a bad web url opens nothing', () => {
    expect(openAppLink('relay://open/web?url=javascript%3Aalert(1)')).toBe(false)
  })
})

describe('openInApp and navigation clicks', () => {
  it('background puts back the front tab and the focus', () => {
    tiling.snapshots = [
      {
        panes: [
          { id: 'p1', views: ['tab:1'], active: 'tab:1' },
          { id: 'p2', views: ['a'], active: 'a' },
        ],
        focus: 'p1',
        zoom: null,
      },
      {
        panes: [
          { id: 'p1', views: ['tab:1'], active: 'tab:1' },
          { id: 'p2', views: ['a', 'b'], active: 'b' },
        ],
        focus: 'p2',
        zoom: null,
      },
    ]
    tiling.focus = 'p2'
    openInApp(placeOf('jobs'), 'background')
    expect(tiling.openPlaceBeside).toHaveBeenCalledWith(placeOf('jobs'))
    expect(tiling.activateTab).toHaveBeenCalledWith('a')
    expect(tiling.focusPaneById).toHaveBeenCalledWith('p1')
  })

  it('a nav click: plain here, Cmd background, Cmd+Shift split', () => {
    openFromNav(placeOf('jobs'), {})
    expect(openPlace).toHaveBeenCalledWith(placeOf('jobs'), { newTab: false })
    openFromNav(placeOf('jobs'), { metaKey: true })
    expect(tiling.openPlaceBeside).toHaveBeenCalledWith(placeOf('jobs'))
    openFromNav(placeOf('jobs'), { metaKey: true, shiftKey: true })
    expect(tiling.splitAt).toHaveBeenCalledWith('p1', 'right', pageTab(placeOf('jobs')))
    openInApp(placeOf('jobs'), 'tab')
    expect(navigateTo).toHaveBeenCalledWith(placeOf('jobs'), { newTab: true })
  })
})
