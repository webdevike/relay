import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))

import { allPanes, findTab, isTabVisible, tilingToJson, toolsShown } from '@evaos/shell-core'
import { runAction } from '../hotkeys/router'
import {
  applySavedTiling,
  closePaneById,
  defaultSplitTab,
  enterScope,
  renameScope,
  reportScopeTabs,
  resetTilingForTests,
  resizeNode,
  setRects,
  splitAt,
  startTiling,
  tilingStore,
  toggleToolPanes,
} from './tiling-store'

const t = () => tilingStore.getState().tiling
const visible = (id: string) => isTabVisible(t(), id)

let stop: () => void
beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: {} })
  resetTilingForTests()
  stop = startTiling()
})
afterEach(() => {
  stop()
  vi.useRealTimers()
})

describe('tiling store', () => {
  it('a browser tab new in the scope in front brings the browser forward; other scopes do not', () => {
    enterScope('chat:/a')
    reportScopeTabs('chat:/a', ['t1'])
    expect(findTab(t(), 'browser')?.pane.active).toBe('browser')
    toggleToolPanes(false)
    reportScopeTabs('chat:/b', ['t2', 't3'])
    expect(toolsShown(t())).toBe(false)
    reportScopeTabs('chat:/a', ['t1'])
    expect(toolsShown(t())).toBe(false)
    reportScopeTabs('chat:/a', ['t1', 't4'])
    expect(visible('browser')).toBe(true)
  })

  it('a renamed draft scope keeps its tabs, so only a really new tab reveals', () => {
    enterScope('draft:1')
    reportScopeTabs('draft:1', ['t1'])
    toggleToolPanes(false)
    renameScope('draft:1', 'chat:/a')
    expect(tilingStore.getState().scope).toBe('chat:/a')
    reportScopeTabs('chat:/a', ['t1'])
    expect(toolsShown(t())).toBe(false)
  })

  it('the panel toggle hides and shows the tool panes, and brings them back when none is left', () => {
    toggleToolPanes()
    expect(t().zoom).toBe('chat')
    toggleToolPanes()
    expect(t().zoom).toBeNull()
    closePaneById('p2')
    expect(allPanes(t().root)).toHaveLength(1)
    toggleToolPanes(true)
    const tool = allPanes(t().root)[1]
    expect(tool?.tabs.map((x) => x.kind)).toEqual(['browser', 'files'])
    expect(visible('browser')).toBe(true)
  })

  it('closing the last tool pane folds the panel first, then removes the pane after the slide', () => {
    document.documentElement.style.setProperty('--eva-dur-slide', '260ms')
    try {
      closePaneById('p2')
      expect(t().zoom).toBe('chat')
      expect(allPanes(t().root)).toHaveLength(2)
      vi.advanceTimersByTime(260)
      expect(t().zoom).toBeNull()
      expect(allPanes(t().root)).toHaveLength(1)
    } finally {
      document.documentElement.style.removeProperty('--eva-dur-slide')
    }
  })

  it('splitting without a tab moves the one in front, else opens a tool not open yet', () => {
    expect(defaultSplitTab(t(), 'p2')).toEqual({ kind: 'browser' })
    const p = splitAt('p2', 'down')
    expect(p).not.toBeNull()
    expect(findTab(t(), 'browser')?.pane.id).toBe(p)
    // Both tools are open in panes of one tab each: nothing to move from the chat pane.
    expect(defaultSplitTab(t(), 'chat')).toBeNull()
    // An only tab with every tool open: nothing to split with.
    expect(splitAt(p!, 'right')).toBeNull()
  })

  it('resizes by px within its minimums', () => {
    setRects({ chat: { x: 0, y: 0, w: 600, h: 800 }, p2: { x: 608, y: 0, w: 400, h: 800 } })
    resizeNode('p2', { px: 300 })
    const sizes = (): number[] => {
      const root = t().root
      return root.type === 'split' ? root.sizes : []
    }
    expect(sizes()[1]).toBeCloseTo(0.3)
    // The chat keeps 480 of the 1000 free px.
    resizeNode('p2', { share: 0.9 })
    expect(sizes()[1]).toBeCloseTo(0.52)
    resizeNode('p2', { px: 10 })
    expect(sizes()[1]).toBeCloseTo(0.24)
  })

  it('saves a moment after each change once loaded, and restores without writing back', () => {
    applySavedTiling(tilingToJson(t()), null, 272)
    expect(invoke).not.toHaveBeenCalled()
    toggleToolPanes(false)
    toggleToolPanes(true)
    toggleToolPanes(false)
    expect(invoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('layout.save', { tiling: tilingToJson(t()) })
  })

  it('runs the pane shortcuts', () => {
    runAction('split-down')
    expect(findTab(t(), 'browser')?.pane.id).not.toBe('p2')
    runAction('zoom-pane')
    expect(t().zoom).toBe(t().focus)
    runAction('zoom-pane')
    expect(t().zoom).toBeNull()
    runAction('close-pane')
    expect(findTab(t(), 'browser')).toBeNull()
  })
})
