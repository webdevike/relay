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
  commitSidebarWidth,
  layoutStore,
  loadLayout,
  previewSidebarWidth,
  resetLayoutStoreForTests,
  resetSidebarWidth,
  setWindowWidth,
  toggleSidebar,
} from './layout-store'
import { resetTilingForTests, tilingStore, toggleToolPanes } from '../tiling/tiling-store'
import { openPlace, setNavigator } from '../navigation/navigate'
import { placeOf, tilingToJson, defaultTiling } from '@evaos/shell-core'

const g = () => layoutStore.getState()

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: {} })
  show.mockReset()
  resetTilingForTests()
  resetLayoutStoreForTests()
  setWindowWidth(1280)
  invoke.mockClear()
})

describe('derived widths', () => {
  it('folds the sidebar when the panes on screen need its room', () => {
    // Chat (480) + gap + one tool pane (240) = 728; the sidebar needs 200 plus the right gap.
    expect(g()).toMatchObject({ contentMin: 728, sidebarPx: 272, state: 'open' })
    setWindowWidth(936)
    expect(g()).toMatchObject({ sidebarPx: 200, state: 'open' })
    setWindowWidth(935)
    expect(g()).toMatchObject({ sidebarPx: 0, state: 'folded' })
  })

  it('hiding the tool panes gives the sidebar its room back', () => {
    setWindowWidth(935)
    toggleToolPanes(false)
    expect(g()).toMatchObject({ contentMin: 480, sidebarPx: 272, state: 'open' })
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
})

describe('drag', () => {
  it('previews without saving and commits once', () => {
    previewSidebarWidth(330)
    expect(g().sidebarPx).toBe(330)
    expect(invoke).not.toHaveBeenCalled()
    commitSidebarWidth()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('layout.save', { sidebarWidth: 330 })
  })

  it('does not fold on preview', () => {
    setWindowWidth(935)
    previewSidebarWidth(300)
    expect(g().sidebarWidth).toBe(272)
    setWindowWidth(936)
    previewSidebarWidth(100)
    expect(g().sidebarPx).toBe(200)
  })

  it('persists the requested width rather than the temporary fit of a narrow window', () => {
    previewSidebarWidth(300)
    setWindowWidth(1000)
    expect(g().sidebarPx).toBe(264)
    commitSidebarWidth()
    expect(invoke).toHaveBeenCalledWith('layout.save', { sidebarWidth: 300 })
    setWindowWidth(1600)
    expect(g().sidebarPx).toBe(300)
  })

  it('resets to the default and saves it', () => {
    previewSidebarWidth(300)
    resetSidebarWidth()
    expect(g().sidebarPx).toBe(272)
    expect(invoke).toHaveBeenLastCalledWith('layout.save', { sidebarWidth: 272 })
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

describe('loadLayout', () => {
  const loaded = (value: Record<string, unknown>) =>
    invoke.mockImplementation((ch: string) =>
      Promise.resolve(
        ch === 'layout.load'
          ? {
              ok: true,
              value: {
                sidebarWidth: 272,
                tabs: null,
                tiling: null,
                legacyPanel: null,
                reset: false,
                ...value,
              },
            }
          : { ok: true, value: {} },
      ),
    )

  it('applies the clamped width and toasts the reset once', async () => {
    loaded({ sidebarWidth: 9999, reset: true })
    await loadLayout()
    await loadLayout()
    expect(g().sidebarWidth).toBe(420)
    expect(show).toHaveBeenCalledTimes(1)
    expect(show.mock.calls[0]![0]).toMatchObject({ message: 'Layout was reset to defaults.' })
  })

  it('keeps defaults when the call fails, and the panes still count as loaded', async () => {
    invoke.mockRejectedValue(new Error('x'))
    await loadLayout()
    expect(g().sidebarWidth).toBe(272)
    expect(show).not.toHaveBeenCalled()
    expect(tilingStore.getState().loaded).toBe(true)
  })

  it('restores the saved pane tree', async () => {
    const saved = tilingToJson(defaultTiling(0.5, 'artifacts'))
    loaded({ tiling: saved })
    await loadLayout()
    expect(tilingToJson(tilingStore.getState().tiling)).toEqual(saved)
    // A restored tree is not written back.
    expect(invoke).not.toHaveBeenCalledWith('layout.save', expect.anything())
  })

  it("migrates the old side panel: its width as the tool pane's share, its tool in front", async () => {
    loaded({ legacyPanel: { width: 420, tool: 'files' } })
    await loadLayout()
    const t = tilingStore.getState().tiling
    // The old width over the room the panes had next to the sidebar (at least chat + panel).
    const room = Math.max(window.innerWidth - 272 - 24, 420 + 480)
    expect(t.root.type === 'split' && t.root.sizes[1]).toBeCloseTo(420 / room)
    expect(t.root.type === 'split' && t.root.children[1]).toMatchObject({ active: 'files' })
    expect(invoke).toHaveBeenCalledWith('layout.save', { tiling: tilingToJson(t) })
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
