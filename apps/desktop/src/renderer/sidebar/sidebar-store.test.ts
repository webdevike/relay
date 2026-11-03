import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))

import { runAction } from '../hotkeys/router'
import { startReload } from '../reload/reload'
import { layoutStore, resetLayoutStoreForTests } from '../shell/layout-store'
import {
  countLabel,
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
    expect(sidebarStore.getState()).toMatchObject({ error: true, openTodos: 0 })
    await refreshSidebar()
    expect(sidebarStore.getState().error).toBe(false)
  })

  it('startSidebar no longer owns the reload action', async () => {
    startSidebar()
    await refreshSidebar()
    invoke.mockClear()
    runAction('reload')
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(0)
  })

  it('reload action refreshes the sidebar once through reload.ts', async () => {
    startSidebar()
    const stop = startReload()
    await refreshSidebar()
    invoke.mockClear()
    runAction('reload')
    runAction('reload')
    await refreshSidebar()
    expect(invoke).toHaveBeenCalledTimes(1)
    stop()
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
    expect(levelForPlace(placeOf('reviews'))).toBe('reviews')
    expect(levelForPlace(placeOf('review:pr:o/r#1'))).toBe('reviews')
    expect(levelForPlace(placeOf('settings'))).toBe('settings')
    expect(levelForPlace(placeOf('habits'))).toBeNull()
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
