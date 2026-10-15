import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { runAction } from '../hotkeys/router'
import { layoutStore, resetLayoutStoreForTests } from '../shell/layout-store'
import {
  countLabel,
  filterRecent,
  refreshSidebar,
  resetSidebarForTests,
  sidebarStore,
  startSidebar,
} from './sidebar-store'
import {
  backToRoot,
  levelForPlace,
  navLevelStore,
  openSub,
  registerSearchFocuser,
} from './nav-level'
import { placeOf } from '@evaos/shell-core'

const ok = {
  ok: true,
  value: {
    openTodos: 2,
    scheduledJobs: 1,
    recent: [{ date: '2026-01-01', tag: 'x', title: 'Alpha' }],
  },
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue(ok)
  resetSidebarForTests()
  resetLayoutStoreForTests()
  backToRoot()
})

describe('sidebar store', () => {
  it('loads once, refetches on focus, disposer removes the listener', async () => {
    const stop = startSidebar()
    await refreshSidebar()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(sidebarStore.getState().openTodos).toBe(2)
    expect(sidebarStore.getState().recent).toHaveLength(1)
    window.dispatchEvent(new Event('focus'))
    await refreshSidebar()
    expect(invoke).toHaveBeenCalledTimes(2)
    stop()
    window.dispatchEvent(new Event('focus'))
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('error hides counts and clears on a later success', async () => {
    invoke.mockResolvedValueOnce({ ok: false, error: 'x' })
    await refreshSidebar()
    expect(sidebarStore.getState()).toMatchObject({ error: true, openTodos: 0, recent: [] })
    await refreshSidebar()
    expect(sidebarStore.getState().error).toBe(false)
  })

  it('reload action refreshes once, concurrent calls share a promise', async () => {
    startSidebar()
    await refreshSidebar()
    invoke.mockClear()
    runAction('reload')
    runAction('reload')
    await refreshSidebar()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('filterRecent is case-insensitive over title and tag and keeps order', () => {
    const r = [
      { date: 'a', tag: 'Ops', title: 'One' },
      { date: 'b', tag: null, title: 'two OPS' },
      { date: 'c', tag: null, title: 'three' },
    ]
    expect(filterRecent(r, '')).toHaveLength(3)
    expect(filterRecent(r, 'ops').map((x) => x.date)).toEqual(['a', 'b'])
  })

  it('countLabel formats', () => {
    expect(countLabel(0)).toBeNull()
    expect(countLabel(7)).toBe('7')
    expect(countLabel(100)).toBe('99+')
  })
})

describe('nav level', () => {
  it('openSub and backToRoot', () => {
    openSub('chats')
    expect(navLevelStore.getState().level).toBe('chats')
    backToRoot()
    expect(navLevelStore.getState().level).toBe('root')
  })
  it('levelForPlace', () => {
    expect(levelForPlace(placeOf('chat'))).toBe('chats')
    expect(levelForPlace(placeOf('meetings'))).toBe('meetings')
    expect(levelForPlace(placeOf('settings'))).toBe('settings')
    expect(levelForPlace(placeOf('inbox'))).toBeNull()
  })
})

describe('focus-search action', () => {
  const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
  it('calls the focuser, showing a hidden sidebar first', async () => {
    startSidebar()
    const fn = vi.fn()
    registerSearchFocuser(fn)
    runAction('focus-search')
    await frame()
    expect(fn).toHaveBeenCalledTimes(1)
    layoutStore.setState({ sidebarWanted: false, state: 'hidden' })
    runAction('focus-search')
    expect(layoutStore.getState().sidebarWanted).toBe(true)
    await frame()
    expect(fn).toHaveBeenCalledTimes(2)
  })
  it('does not throw without a focuser', async () => {
    startSidebar()
    expect(() => runAction('focus-search')).not.toThrow()
    await frame()
  })
})
