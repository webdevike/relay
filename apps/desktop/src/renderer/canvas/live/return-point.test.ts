import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ipc', () => ({
  invoke: vi.fn(() => Promise.resolve({ ok: false, error: { code: 'test', message: 'test' } })),
  on: vi.fn(() => () => {}),
}))

import { activeTab, appPanelId, placeOf, samePlace, type Place } from '@evaos/shell-core'
import { navigateTo, resetTabsForTests, tabsStore } from '../../tabs/tabs-store'
import { chatStore } from '../../chat/chat-store'
import { resetFrontChatForTests, setTabChatPane } from '../../chat/front-chat'
import {
  rememberChatScroll,
  resetChatScrollForTests,
  takeChatScrollRequest,
} from '../../chat/chat-scroll'
import {
  focusPaneById,
  openSubagentTab,
  resetTilingForTests,
  startTiling,
  tilingStore,
} from '../../tiling/tiling-store'
import { mountTestDock } from '../../tiling/test-dock'
import { backToChat, joinCanvas, resetReturnPointsForTests, returnPointOf } from './return-point'

const FILE = '/s/-fixture/2026-10-28T10-00-00-000Z_s1.jsonl'
const CHAT = placeOf('chat', { chat: FILE })
const BOARD = placeOf('canvas', { canvas: 'mind-map' })
const ROADMAP = placeOf('canvas', { canvas: 'roadmap' })
const meta = { model: null, thinking: null, contextTokens: null }

let unmount = (): void => {}
let stop = (): void => {}
beforeEach(() => {
  unmount()
  stop()
  resetTabsForTests()
  resetTilingForTests()
  resetFrontChatForTests()
  resetChatScrollForTests()
  resetReturnPointsForTests()
  tabsStore.setState({ loaded: true })
  stop = startTiling()
  unmount = mountTestDock()
  navigateTo(CHAT)
  const tab = activeTab(tabsStore.getState().tabs).id
  setTabChatPane(tab, 'pane-chat')
  chatStore.getState().openPane('pane-chat', { file: FILE, title: 'Plan', messages: [], meta })
})

/** The pane showing the app tab on `place`. */
const paneShowing = (place: Place): string | undefined => {
  const tab = tabsStore.getState().tabs.list.find((t) => samePlace(t.here, place))
  return tab
    ? tilingStore.getState().panes.find((p) => p.views.includes(appPanelId(tab.id)))?.id
    : undefined
}

const here = () => activeTab(tabsStore.getState().tabs)

describe('join and back to chat', () => {
  it('joins in the same tab and comes back by Back, to the same offset, panes untouched', () => {
    rememberChatScroll(FILE, { offset: 420, pinned: false })
    openSubagentTab({ session: FILE, file: '/s/sub.jsonl', name: 'Scout' })
    // The click is in the chat pane, so the chat pane has the focus.
    focusPaneById(paneShowing(CHAT)!)
    const panes = tilingStore.getState().panes
    const tabs = tabsStore.getState().tabs.list.length

    joinCanvas('mind-map', 'here')
    expect(here().here).toEqual(BOARD)
    expect(here().back.at(-1)).toEqual(CHAT)
    expect(tabsStore.getState().tabs.list).toHaveLength(tabs)
    expect(returnPointOf('mind-map')).toMatchObject({ place: CHAT, file: FILE })

    backToChat('mind-map', null)
    expect(here().here).toEqual(CHAT)
    // Back, not a new visit: the board is Forward now.
    expect(here().forward.at(-1)).toEqual(BOARD)
    expect(takeChatScrollRequest(FILE)).toEqual({ offset: 420, pinned: false })
    expect(takeChatScrollRequest(FILE)).toBeNull()
    expect(tilingStore.getState().panes).toBe(panes)
    expect(returnPointOf('mind-map')).toBeNull()
  })

  it('joins in a pane right of the chat by default: the tab stays on the chat, no return point', () => {
    const tabs = tabsStore.getState().tabs.list.length
    joinCanvas('mind-map')
    expect(here().here).toEqual(CHAT)
    // The board is a tab of its own in that pane; the chat stays the app tab in front.
    expect(tabsStore.getState().tabs.list).toHaveLength(tabs + 1)
    expect(returnPointOf('mind-map')).toBeNull()
    const pane = paneShowing(BOARD)
    expect(pane).toBeDefined()
    expect(pane).not.toBe(paneShowing(CHAT))
    expect(tilingStore.getState().focus).toBe(pane)
    // A second board joins as a tab of that same pane.
    joinCanvas('roadmap')
    expect(paneShowing(ROADMAP)).toBe(pane)
  })

  it('Cmd+click joins in a new tab with the way back', () => {
    const tabs = tabsStore.getState().tabs.list.length
    joinCanvas('mind-map', 'tab')
    expect(tabsStore.getState().tabs.list).toHaveLength(tabs + 1)
    expect(here().here).toEqual(BOARD)
    expect(returnPointOf('mind-map')).toMatchObject({ place: CHAT, file: FILE })
  })
  it('visits the chat when it is not the previous page', () => {
    joinCanvas('mind-map', 'here')
    navigateTo(placeOf('dashboard'))
    navigateTo(BOARD)
    backToChat('mind-map', null)
    expect(here().here).toEqual(CHAT)
    expect(here().back.at(-1)).toEqual(BOARD)
    expect(here().forward).toEqual([])
  })

  it("goes to the room's own chat without a return point, and stays put without either", () => {
    navigateTo(BOARD)
    const nova = placeOf('agent:nova')
    backToChat('mind-map', nova)
    expect(here().here).toEqual(nova)
    navigateTo(BOARD)
    backToChat('mind-map', null)
    expect(here().here).toEqual(BOARD)
  })
})
