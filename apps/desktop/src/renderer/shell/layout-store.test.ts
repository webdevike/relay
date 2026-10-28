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
  enterPanelScope,
  layoutStore,
  loadLayout,
  openSubagentPanel,
  panelTabCreated,
  previewWidth,
  renamePanelScope,
  reportScopeTabs,
  resetLayoutStoreForTests,
  resetWidth,
  setWindowWidth,
  settlePanelView,
  showPanelTool,
  toggleSidebar,
  togglePanel,
} from './layout-store'
import type { PanelTool } from './layout-store'
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
  invoke.mockClear()
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
      value: {
        sidebarWidth: 9999,
        panelWidth: 10,
        tabs: null,
        panelChoices: {},
        panelTool: 'browser',
        reset: true,
      },
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

  const loaded = (panelChoices: Record<string, boolean>, panelTool: PanelTool) =>
    invoke.mockImplementation((ch: string) =>
      Promise.resolve(
        ch === 'layout.load'
          ? {
              ok: true,
              value: {
                sidebarWidth: 272,
                panelWidth: 420,
                tabs: null,
                panelChoices,
                panelTool,
                reset: false,
              },
            }
          : { ok: true, value: {} },
      ),
    )

  it('restores the saved per-scope choice and tool after a restart', async () => {
    resetLayoutStoreForTests()
    loaded({ 'chat:/a': true, 'chat:/b': false }, 'files')
    await loadLayout()
    enterPanelScope('chat:/a')
    expect(g()).toMatchObject({ panelOpen: true, panelView: { kind: 'files' } })
    reportScopeTabs('chat:/b', ['t1'])
    enterPanelScope('chat:/b')
    expect(g().panelOpen).toBe(false)
  })

  it('applies the saved choice to a scope entered before the load resolved', async () => {
    resetLayoutStoreForTests()
    enterPanelScope('chat:/a')
    expect(g().panelOpen).toBe(false)
    loaded({ 'chat:/a': true }, 'files')
    await loadLayout()
    expect(g()).toMatchObject({ panelOpen: true, panelView: { kind: 'files' } })
    // The saved choice decides, so the scope's first (empty) tab report no longer closes it.
    reportScopeTabs('chat:/a', [])
    expect(g().panelOpen).toBe(true)
  })

  it('a choice or tool picked before the load resolved wins over the saved one', async () => {
    resetLayoutStoreForTests()
    enterPanelScope('chat:/a')
    showPanelTool('browser')
    togglePanel(false)
    loaded({ 'chat:/a': true, 'chat:/z': true }, 'files')
    await loadLayout()
    expect(g()).toMatchObject({ panelOpen: false, panelView: { kind: 'browser' } })
    enterPanelScope('chat:/z')
    expect(g().panelOpen).toBe(true)
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

describe('panel per browser scope', () => {
  beforeEach(() => resetLayoutStoreForTests())
  const open = (): boolean => g().panelOpen
  const saves = () => invoke.mock.calls.filter((c) => c[0] === 'layout.save').map((c) => c[1])

  it('saves each choice and tool change to layout.json', () => {
    invoke.mockClear()
    enterPanelScope('A')
    togglePanel(false)
    showPanelTool('files')
    panelTabCreated()
    togglePanel(false)
    panelTabCreated()
    renamePanelScope('A', 'B')
    expect(saves()).toEqual([
      { panelChoices: { A: false } },
      { panelChoices: { A: true }, panelTool: 'files' },
      { panelTool: 'browser' },
      { panelChoices: { A: false } },
      { panelChoices: { A: true } },
      { panelChoices: { A: null, B: true } },
    ])
  })

  it('keeps only the most recent 200 choices', () => {
    for (let i = 0; i < 205; i++) {
      enterPanelScope(`s${i}`)
      togglePanel(true)
    }
    enterPanelScope('s0')
    togglePanel(false)
    enterPanelScope('s5')
    expect(open()).toBe(false)
    enterPanelScope('s6')
    expect(open()).toBe(true)
    enterPanelScope('s0')
    expect(open()).toBe(false)
  })

  it('a never-toggled scope is open iff it has its own tabs', () => {
    enterPanelScope('chat:/a')
    expect(open()).toBe(false)
    reportScopeTabs('chat:/a', ['t1'])
    expect(open()).toBe(true)
    enterPanelScope('chat:/b')
    expect(open()).toBe(false)
    reportScopeTabs('chat:/b', [])
    expect(open()).toBe(false)
    enterPanelScope('chat:/a')
    expect(open()).toBe(true)
  })

  it('pinned tabs alone never open it', () => {
    enterPanelScope('page:dashboard')
    // The browser store reports only unpinned ids as the scope's own tabs.
    reportScopeTabs('page:dashboard', [])
    expect(open()).toBe(false)
  })

  it("remembers Isaac's toggle per scope", () => {
    enterPanelScope('A')
    reportScopeTabs('A', ['t1'])
    togglePanel(false)
    enterPanelScope('B')
    reportScopeTabs('B', [])
    togglePanel(true)
    enterPanelScope('A')
    expect(open()).toBe(false)
    enterPanelScope('B')
    expect(open()).toBe(true)
    enterPanelScope('C')
    expect(open()).toBe(false)
  })

  it('a tab created in the scope in front opens it, closing the last one does not close it', () => {
    enterPanelScope('A')
    reportScopeTabs('A', [])
    reportScopeTabs('A', ['t1'])
    expect(open()).toBe(true)
    reportScopeTabs('A', [])
    expect(open()).toBe(true)
    togglePanel(false)
    panelTabCreated()
    expect(open()).toBe(true)
    enterPanelScope('B')
    enterPanelScope('A')
    expect(open()).toBe(true)
  })

  it('reports for another scope leave the panel alone', () => {
    enterPanelScope('A')
    reportScopeTabs('A', [])
    reportScopeTabs('B', ['t9'])
    expect(open()).toBe(false)
    enterPanelScope('B')
    expect(open()).toBe(true)
  })

  it('a renamed draft scope keeps its state', () => {
    enterPanelScope('draft:2')
    reportScopeTabs('draft:2', ['t1'])
    togglePanel(false)
    renamePanelScope('draft:2', 'chat:/n')
    expect(g().panelScope).toBe('chat:/n')
    enterPanelScope('page:dashboard')
    enterPanelScope('chat:/n')
    expect(open()).toBe(false)
  })
})

describe('panel view', () => {
  const view = { session: '/s/a.jsonl', file: '/s/a/0-Scout.jsonl', name: '0-Scout' }

  it('a subagent opens the panel on its transcript without changing the browser choice', () => {
    enterPanelScope('chat:/s/a')
    togglePanel(false)
    openSubagentPanel(view)
    expect(g().panelOpen).toBe(true)
    expect(g().panelView).toEqual({ kind: 'subagent', ...view })
    enterPanelScope('chat:/s/b')
    enterPanelScope('chat:/s/a')
    expect(g().panelOpen).toBe(false)
  })

  it('a scope change, a new tab or settlePanelView goes back to the browser', () => {
    enterPanelScope('chat:/s/a')
    openSubagentPanel(view)
    enterPanelScope('chat:/s/b')
    expect(g().panelView).toEqual({ kind: 'browser' })
    openSubagentPanel(view)
    panelTabCreated()
    expect(g().panelView).toEqual({ kind: 'browser' })
    openSubagentPanel(view)
    settlePanelView()
    expect(g().panelView).toEqual({ kind: 'browser' })
  })

  it('the files tool opens the panel and stays across scopes until a browser tab opens', () => {
    enterPanelScope('chat:/s/a')
    togglePanel(false)
    showPanelTool('files')
    expect(g().panelOpen).toBe(true)
    expect(g().panelView).toEqual({ kind: 'files' })
    openSubagentPanel(view)
    settlePanelView()
    expect(g().panelView).toEqual({ kind: 'files' })
    enterPanelScope('chat:/s/b')
    expect(g().panelView).toEqual({ kind: 'files' })
    panelTabCreated()
    expect(g().panelView).toEqual({ kind: 'browser' })
  })

  it('the artifacts tool settles back from a subagent view and follows scope changes', () => {
    enterPanelScope('chat:/s/a')
    showPanelTool('artifacts')
    expect(g()).toMatchObject({ panelOpen: true, panelView: { kind: 'artifacts' } })
    openSubagentPanel(view)
    settlePanelView()
    expect(g().panelView).toEqual({ kind: 'artifacts' })
    enterPanelScope('chat:/s/b')
    expect(g().panelView).toEqual({ kind: 'artifacts' })
    panelTabCreated()
    expect(g().panelView).toEqual({ kind: 'browser' })
  })
})
