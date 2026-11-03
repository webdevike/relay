import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ipc', () => ({
  invoke: vi.fn(() => Promise.resolve({ ok: false, error: { code: 'test', message: 'test' } })),
  on: vi.fn(() => () => {}),
}))

import { activeTab, allPanes, CHAT_PANE, isChatPane, placeOf, tabId } from '@evaos/shell-core'
import { navigateTo, resetTabsForTests, tabsStore } from '../../tabs/tabs-store'
import { chatStore } from '../../chat/chat-store'
import { PANE_ID } from '../../chat/open-chat'
import {
  rememberChatScroll,
  resetChatScrollForTests,
  takeChatScrollRequest,
} from '../../chat/chat-scroll'
import {
  focusPaneById,
  openSubagentTab,
  resetTilingForTests,
  tilingStore,
} from '../../tiling/tiling-store'
import { backToChat, joinCanvas, resetReturnPointsForTests, returnPointOf } from './return-point'

const FILE = '/s/-fixture/2026-10-28T10-00-00-000Z_s1.jsonl'
const CHAT = placeOf('chat', { chat: FILE })
const BOARD = placeOf('canvas', { canvas: 'mind-map' })
const BOARD_TAB = { kind: 'page', place: BOARD } as const
const ROADMAP = placeOf('canvas', { canvas: 'roadmap' })
const meta = { model: null, thinking: null, contextTokens: null }

beforeEach(() => {
  resetTabsForTests()
  resetTilingForTests()
  resetChatScrollForTests()
  resetReturnPointsForTests()
  navigateTo(CHAT)
  chatStore.getState().openPane(PANE_ID, { file: FILE, title: 'Plan', messages: [], meta })
})

const here = () => activeTab(tabsStore.getState().tabs)

describe('join and back to chat', () => {
  it('joins in the same tab and comes back by Back, to the same offset, panes untouched', () => {
    rememberChatScroll(FILE, { offset: 420, pinned: false })
    openSubagentTab({ session: FILE, file: '/s/sub.jsonl', name: 'Scout' })
    // The click is in the chat pane, so the chat pane has the focus.
    focusPaneById(CHAT_PANE)
    const panes = tilingStore.getState().tiling
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
    expect(tilingStore.getState().tiling).toBe(panes)
    expect(returnPointOf('mind-map')).toBeNull()
  })

  it('joins in a pane right of the chat by default: the tab stays on the chat, no return point', () => {
    const tabs = tabsStore.getState().tabs.list.length
    joinCanvas('mind-map')
    expect(here().here).toEqual(CHAT)
    expect(tabsStore.getState().tabs.list).toHaveLength(tabs)
    expect(returnPointOf('mind-map')).toBeNull()
    const t = tilingStore.getState().tiling
    const pane = allPanes(t.root).find((p) => p.tabs.some((x) => tabId(x) === tabId(BOARD_TAB)))
    expect(pane).toBeDefined()
    expect(isChatPane(pane!.id)).toBe(false)
    expect(t.focus).toBe(pane!.id)
    // A second board joins as a tab of that same pane.
    joinCanvas('roadmap')
    const after = allPanes(tilingStore.getState().tiling.root).find((p) => p.id === pane!.id)
    expect(after?.tabs.map(tabId)).toEqual(
      expect.arrayContaining([tabId(BOARD_TAB), tabId({ kind: 'page', place: ROADMAP })]),
    )
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
