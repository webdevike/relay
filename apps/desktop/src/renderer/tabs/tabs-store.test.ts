import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))

import { placeOf, saveTabs } from '@evaos/shell-core'
import { runAction } from '../hotkeys/router'
import { openPlace } from '../navigation/navigate'
import { setMeetingTitles, setWorkspaceNames } from '../eva/names-store'
import { tabIconName, tabTitle } from './tab-meta'
import { resetTilingForTests, startTiling } from '../tiling/tiling-store'
import {
  activePlace,
  navigateTo,
  newChatTab,
  resetTabsForTests,
  startTabs,
  tabsStore,
  togglePinOf,
  flushPendingTabs,
} from './tabs-store'

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}
const saves = () => invoke.mock.calls.filter((c) => c[0] === 'layout.save')
const t = () => tabsStore.getState().tabs
const loadWith = (tabs: unknown) =>
  invoke.mockImplementation(async (ch: string) =>
    ch === 'layout.load' ? { ok: true, value: { tabs } } : { ok: true, value: {} },
  )

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  resetTabsForTests()
  loadWith(null)
})
afterEach(() => {
  resetTabsForTests()
  vi.useRealTimers()
})

describe('startTabs', () => {
  it('garbage gives one Dashboard tab and loaded flips', async () => {
    loadWith('garbage')
    startTabs()
    await flush()
    expect(tabsStore.getState().loaded).toBe(true)
    expect(t().list).toHaveLength(1)
    expect(activePlace(tabsStore.getState()).page).toBe('dashboard')
  })

  it('loaded flips even when layout.load fails', async () => {
    invoke.mockRejectedValue(new Error('x'))
    startTabs()
    await flush()
    expect(tabsStore.getState().loaded).toBe(true)
  })

  it('restores saved tabs and does not echo a save', async () => {
    const saved = {
      active: 1,
      list: [
        { here: { page: 'habits' }, back: [], forward: [], pinned: true },
        { here: { page: 'jobs' }, back: [], forward: [], pinned: false },
      ],
    }
    loadWith(saved)
    startTabs()
    await flush()
    expect(t().list.map((x) => x.here.page)).toEqual(['habits', 'jobs'])
    expect(t().active).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(saves()).toHaveLength(0)
  })
})

describe('save failures', () => {
  it('a not-ok save reply is retried on the next change', async () => {
    startTabs()
    await flush()
    let ok = false
    invoke.mockImplementation(async (ch: string) =>
      ch === 'layout.save' ? (ok ? { ok: true, value: {} } : { ok: false, error: 'x' }) : {},
    )
    navigateTo(placeOf('habits'))
    await vi.advanceTimersByTimeAsync(300)
    expect(saves()).toHaveLength(1)
    ok = true
    navigateTo(placeOf('habits'))
    navigateTo(placeOf('jobs'))
    await vi.advanceTimersByTimeAsync(300)
    expect(saves()).toHaveLength(2)
  })
})

describe('flushPendingTabs', () => {
  it('writes a debounced change immediately', async () => {
    startTabs()
    await flush()
    navigateTo(placeOf('habits'))
    expect(saves()).toHaveLength(0)
    flushPendingTabs()
    expect(saves()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(saves()).toHaveLength(1)
  })
})

describe('navigation', () => {
  beforeEach(async () => {
    startTabs()
    await flush()
  })

  it("opens another workspace's place in its own tab; the tab it left keeps its place", () => {
    navigateTo(placeOf('habits'))
    expect(t().list.map((x) => x.here.page)).toEqual(['dashboard', 'habits'])
    expect(activePlace(tabsStore.getState()).page).toBe('habits')
    expect(t().list[0]!.back).toHaveLength(0)
  })

  it('navigates within a workspace in place, with history', () => {
    navigateTo(placeOf('settings', { settingsSection: 'Theme' }))
    navigateTo(placeOf('settings', { settingsSection: 'Chat' }))
    expect(t().list).toHaveLength(2)
    expect(activePlace(tabsStore.getState()).settingsSection).toBe('Chat')
    expect(t().list[1]!.back).toHaveLength(1)
  })

  it('newTab forks, and an already open place is switched to', () => {
    navigateTo(placeOf('habits'), { newTab: true })
    expect(t().list.map((x) => x.here.page)).toEqual(['dashboard', 'habits'])
    navigateTo(placeOf('dashboard'), { newTab: true })
    expect(t().list).toHaveLength(2)
    expect(activePlace(tabsStore.getState()).page).toBe('dashboard')
  })

  it('from a pinned tab opens another tab', () => {
    togglePinOf(t().list[0]!.id)
    navigateTo(placeOf('jobs'))
    expect(t().list).toHaveLength(2)
    expect(t().list[0]!.here.page).toBe('dashboard')
    expect(activePlace(tabsStore.getState()).page).toBe('jobs')
  })

  it('actions: new, close, pinned skip, last tab, history', () => {
    // Close tab is a pane action now (tiling-store; Cmd+T opens a web page), history stays here.
    resetTilingForTests()
    const stopTiling = startTiling()
    newChatTab()
    expect(t().list).toHaveLength(2)
    expect(activePlace(tabsStore.getState()).page).toBe('chat')
    runAction('close-tab')
    expect(t().list).toHaveLength(1)
    runAction('close-tab')
    expect(t().list).toHaveLength(1)
    expect(activePlace(tabsStore.getState()).page).toBe('dashboard')
    togglePinOf(t().list[0]!.id)
    runAction('close-tab')
    expect(t().list).toHaveLength(1)
    togglePinOf(t().list[0]!.id)
    navigateTo(placeOf('settings', { settingsSection: 'Theme' }))
    navigateTo(placeOf('settings', { settingsSection: 'Chat' }))
    runAction('history-back')
    expect(activePlace(tabsStore.getState()).settingsSection).toBe('Theme')
    runAction('history-forward')
    expect(activePlace(tabsStore.getState()).settingsSection).toBe('Chat')
    stopTiling()
  })

  it("a step back into another workspace shows it there and leaves this tab's place", () => {
    const tab = { ...t().list[0]!, here: placeOf('jobs'), back: [placeOf('habits')] }
    tabsStore.setState({ tabs: { ...t(), list: [tab] } })
    runAction('history-back')
    expect(t().list.map((x) => x.here.page)).toEqual(['jobs', 'habits'])
    expect(activePlace(tabsStore.getState()).page).toBe('habits')
  })

  it('openPlace reaches the store with newTab forwarded', () => {
    openPlace(placeOf('jobs'), { newTab: true })
    expect(t().list).toHaveLength(2)
    expect(activePlace(tabsStore.getState()).page).toBe('jobs')
  })
})

describe('persistence', () => {
  it('coalesces bursts into one save after 250 ms and skips no-ops', async () => {
    startTabs()
    await flush()
    navigateTo(placeOf('habits'))
    navigateTo(placeOf('jobs'))
    await vi.advanceTimersByTimeAsync(249)
    expect(saves()).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(saves()).toHaveLength(1)
    expect(saves()[0]![1]).toEqual({ tabs: saveTabs(t()) })
    navigateTo(placeOf('jobs'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(saves()).toHaveLength(1)
  })
})

describe('tab-meta', () => {
  it('titles', () => {
    expect(tabTitle(placeOf('dashboard'))).toBe('Dashboard')
    expect(tabTitle(placeOf('chat'))).toBe('New chat')
    for (const s of ['Theme', 'Chat'] as const)
      expect(tabTitle(placeOf('settings', { settingsSection: s }))).toBe(`Settings: ${s}`)
    expect(tabTitle(placeOf('workspace:abc'))).toBe('abc')
    setWorkspaceNames({ flo: 'Flo' })
    expect(tabTitle(placeOf('workspace:flo'))).toBe('Flo')
    expect(tabIconName(placeOf('workspace:flo'))).toBe('IconFolder')
    expect(tabTitle(placeOf('meetings', { meeting: 'zz' }))).toBe('zz')
    setMeetingTitles({ zz: 'Zed sync' })
    expect(tabTitle(placeOf('meetings', { meeting: 'zz' }))).toBe('Zed sync')
    expect(tabIconName(placeOf('meetings', { meeting: 'zz' }))).toBe('IconUsers')
  })
  it('icons', () => {
    expect(tabIconName(placeOf('habits'))).toBe('IconFlame')
    expect(tabIconName(placeOf('chat'))).toBe('IconMessage')
    expect(tabIconName(placeOf('settings'))).toBe('IconSettings')
    expect(tabIconName(placeOf('jobs'))).toBe('IconCalendarTime')
  })
})
