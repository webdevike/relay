import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))
const show = vi.fn()
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))

import {
  commitWidth,
  layoutStore,
  loadLayout,
  previewWidth,
  resetLayoutStoreForTests,
  resetWidth,
  setWindowWidth,
  toggleSidebar,
  togglePanel,
} from './layout-store'
import { openPlace, setNavigator } from '../navigation/navigate'
import { placeOf } from '@evaos/shell-core'

const g = () => layoutStore.getState()

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: {} })
  show.mockReset()
  resetLayoutStoreForTests()
  setWindowWidth(1280)
  // The fit and drag cases below measure a shell with the panel showing.
  togglePanel(true)
})

it('the right panel starts closed', () => {
  resetLayoutStoreForTests()
  setWindowWidth(1280)
  expect(g().panelOpen).toBe(false)
  expect(g().panelPx).toBe(0)
})

describe('derived widths', () => {
  it('follows the fit vectors', () => {
    expect(g()).toMatchObject({ sidebarPx: 272, panelPx: 420, state: 'open' })
    setWindowWidth(1016)
    expect(g()).toMatchObject({ sidebarPx: 200, state: 'open' })
    setWindowWidth(1015)
    expect(g()).toMatchObject({ sidebarPx: 0, state: 'folded' })
    for (const w of [800, 760]) {
      setWindowWidth(w)
      expect(g()).toMatchObject({ sidebarPx: 0, panelPx: 320, state: 'folded' })
    }
  })
})

describe('preferences', () => {
  it('toggleSidebar is a memory-only preference', () => {
    toggleSidebar()
    expect(g().state).toBe('hidden')
    expect(g().sidebarWidth).toBe(272)
    toggleSidebar()
    expect(g().state).toBe('open')
    setWindowWidth(760)
    toggleSidebar()
    expect(g().state).toBe('hidden')
    toggleSidebar()
    expect(g().state).toBe('folded')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('togglePanel closes and restores', () => {
    togglePanel(false)
    expect(g().panelPx).toBe(0)
    expect(g().sidebarPx).toBe(272)
    togglePanel(true)
    expect(g().panelPx).toBe(420)
  })
})

describe('drag', () => {
  it('previews without saving and commits once', () => {
    previewWidth('sidebar', 330)
    expect(g().sidebarPx).toBe(330)
    expect(invoke).not.toHaveBeenCalled()
    commitWidth('sidebar')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('layout.save', { sidebarWidth: 330 })
  })

  it('does not fold on preview and clamps the panel', () => {
    setWindowWidth(1015)
    previewWidth('sidebar', 300)
    expect(g().sidebarWidth).toBe(272)
    setWindowWidth(1016)
    previewWidth('sidebar', 100)
    expect(g().sidebarPx).toBe(200)
    previewWidth('panel', 99999)
    expect(1016 - g().sidebarPx - g().panelPx - 16).toBeGreaterThanOrEqual(480)
  })

  it('persists requested widths rather than the temporary fit of a narrow window', () => {
    previewWidth('sidebar', 300)
    previewWidth('panel', 600)
    setWindowWidth(1100)
    expect(g()).toMatchObject({ sidebarPx: 284, panelPx: 320 })
    commitWidth('sidebar')
    commitWidth('panel')
    expect(invoke).toHaveBeenCalledWith('layout.save', { sidebarWidth: 300 })
    expect(invoke).toHaveBeenCalledWith('layout.save', { panelWidth: 600 })
    setWindowWidth(1600)
    expect(g()).toMatchObject({ sidebarPx: 300, panelPx: 600 })
  })

  it('keeps a clamped drag preference when the current window cannot display it', () => {
    setWindowWidth(1100)
    previewWidth('sidebar', 500)
    previewWidth('panel', 600)
    expect(g()).toMatchObject({
      sidebarWidth: 420,
      sidebarPx: 284,
      panelWidth: 600,
      panelPx: 320,
    })
    commitWidth('sidebar')
    commitWidth('panel')
    expect(invoke).toHaveBeenCalledWith('layout.save', { sidebarWidth: 420 })
    expect(invoke).toHaveBeenCalledWith('layout.save', { panelWidth: 600 })
    setWindowWidth(1800)
    expect(g()).toMatchObject({ sidebarPx: 420, panelPx: 600 })
  })

  it('resets to defaults and saves once each', () => {
    previewWidth('sidebar', 300)
    resetWidth('sidebar')
    expect(g().sidebarPx).toBe(272)
    expect(invoke).toHaveBeenLastCalledWith('layout.save', { sidebarWidth: 272 })
    previewWidth('panel', 600)
    resetWidth('panel')
    expect(g().panelPx).toBe(420)
    expect(invoke).toHaveBeenLastCalledWith('layout.save', { panelWidth: 420 })
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})

describe('loadLayout', () => {
  it('applies clamped widths and toasts the reset once', async () => {
    invoke.mockResolvedValue({
      ok: true,
      value: { sidebarWidth: 9999, panelWidth: 10, tabs: null, reset: true },
    })
    await loadLayout()
    await loadLayout()
    expect(g().sidebarWidth).toBe(420)
    expect(g().panelWidth).toBe(320)
    expect(show).toHaveBeenCalledTimes(1)
    expect(show.mock.calls[0]![0]).toMatchObject({ message: 'Layout was reset to defaults.' })
  })

  it('keeps defaults when the call fails', async () => {
    invoke.mockRejectedValue(new Error('x'))
    await loadLayout()
    expect(g().sidebarWidth).toBe(272)
    expect(show).not.toHaveBeenCalled()
  })
})

describe('openPlace', () => {
  it('is a no-op until bound', () => {
    expect(() => openPlace(placeOf('jobs'))).not.toThrow()
    const fn = vi.fn()
    setNavigator(fn)
    openPlace(placeOf('jobs'), { newTab: true })
    expect(fn).toHaveBeenCalledWith(placeOf('jobs'), { newTab: true })
    setNavigator(null)
  })
})
