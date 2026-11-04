import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))

import { createDockview, type DockviewApi } from 'dockview-react'
import { createTabs, placeOf, type Tab } from '@evaos/shell-core'
import { runAction } from '../hotkeys/router'
import { navigateTo, newChatTab, resetTabsForTests, tabsStore } from '../tabs/tabs-store'
import {
  applySavedLayout,
  attachDock,
  closeAppTab,
  closePaneById,
  enterScope,
  moveTab,
  openPlaceBeside,
  openTab,
  renameScope,
  reportScopeTabs,
  resetTilingForTests,
  splitAt,
  startTiling,
  tabVisible,
  tilingStore,
  toggleToolPanes,
  toolsShown,
  nextGroupId,
} from './tiling-store'

const tab = (id: number, page: Parameters<typeof placeOf>[0], extra = {}): Tab => ({
  id,
  here: placeOf(page, extra),
  back: [],
  forward: [],
  pinned: false,
})

/** Each pane as `id[views]`, in layout order, the one in front starred. */
const panes = (): string[] =>
  tilingStore
    .getState()
    .panes.map((p) => `${p.id}[${p.views.map((v) => (v === p.active ? `*${v}` : v)).join(',')}]`)

const saves = (): Array<Record<string, unknown>> =>
  invoke.mock.calls
    .filter((c) => c[0] === 'layout.save' && (c[1] as { dock?: unknown }).dock)
    .map((c) => (c[1] as { dock: Record<string, unknown> }).dock)

let stop: () => void
let api: DockviewApi
let detach: () => void
let host: HTMLDivElement

function mount(saved: { dock?: unknown; tiling?: unknown } = {}, list?: Tab[], active = 1): void {
  tabsStore.setState(
    {
      tabs: createTabs(
        list ?? [tab(0, 'dashboard'), tab(1, 'chat', { chat: '/s/a.jsonl' })],
        active,
      ),
      loaded: true,
    },
    true,
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  api = createDockview(host, {
    createComponent: () => {
      const element = document.createElement('div')
      return { element, init: () => {} }
    },
    disableFloatingGroups: true,
    groupIdGenerator: nextGroupId,
  })
  api.layout(1200, 800)
  detach = attachDock(api, host)
  applySavedLayout({
    dock: saved.dock ?? null,
    tiling: saved.tiling ?? null,
    legacy: null,
    sidebarWidth: 272,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: {} })
  resetTabsForTests()
  resetTilingForTests()
  stop = startTiling()
})
afterEach(() => {
  stop()
  detach()
  api.dispose()
  host.remove()
  vi.useRealTimers()
})

describe('tiling store on dockview', () => {
  it('builds the default panes once the tabs load and saves them at once', () => {
    mount()
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[*browser,files]'])
    expect(tilingStore.getState()).toMatchObject({ loaded: true, lead: 'p1', zoom: null })
    expect(saves()).toHaveLength(1)
    expect(saves()[0]).toMatchObject({ grid: expect.any(Object), panels: expect.any(Object) })
  })

  it('restores a saved layout without writing it back', () => {
    mount()
    const saved = api.toJSON()
    detach()
    api.dispose()
    host.remove()
    resetTilingForTests()
    invoke.mockClear()
    mount({ dock: JSON.parse(JSON.stringify(saved)) })
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[*browser,files]'])
    vi.advanceTimersByTime(1000)
    expect(saves()).toHaveLength(0)
  })

  it('migrates the old split tree once: pages in tool panes become app tabs there', () => {
    mount({
      tiling: {
        root: {
          type: 'split',
          id: 's1',
          dir: 'row',
          sizes: [0.6, 0.4],
          children: [
            { type: 'pane', id: 'chat', tabs: [], active: null },
            {
              type: 'pane',
              id: 'p2',
              tabs: [{ kind: 'files' }, { kind: 'page', place: { page: 'jobs' } }],
              active: 'page:jobs',
            },
          ],
        },
      },
    })
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[files,*tab:2]'])
    expect(tabsStore.getState().tabs.list.map((t) => t.here.page)).toEqual([
      'dashboard',
      'chat',
      'jobs',
    ])
    expect(saves()).toHaveLength(1)
  })

  it('follows the tabs store: new tabs join the active pane, closing keeps the focus there', () => {
    mount()
    newChatTab()
    expect(panes()[0]).toBe('p1[tab:0,tab:1,*tab:2]')
    closeAppTab(2)
    expect(panes()[0]).toBe('p1[tab:0,*tab:1]')
    expect(tabsStore.getState().tabs.list[tabsStore.getState().tabs.active]!.id).toBe(1)
    // A dockview activation is the tabs store's too.
    api.getPanel('tab:0')!.api.setActive()
    expect(tabsStore.getState().tabs.active).toBe(0)
    // The last tab leaves a Dashboard tab in the same pane.
    closeAppTab(0)
    closeAppTab(1)
    expect(panes()[0]).toMatch(/^p1\[\*tab:\d+\]$/)
    expect(tabsStore.getState().tabs.list.map((t) => t.here.page)).toEqual(['dashboard'])
  })

  it('opens links beside the chat: in the pane right of it, else a new pane', () => {
    mount()
    openPlaceBeside(placeOf('jobs'))
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[browser,files,*tab:2]'])
    // Opening it again brings it forward instead of opening it twice.
    api.getPanel('tab:1')!.api.setActive()
    openPlaceBeside(placeOf('jobs'))
    expect(tabsStore.getState().tabs.list).toHaveLength(3)
    expect(tabVisible('tab:2')).toBe(true)
    // With the app tabs alone, a new pane splits off right of them.
    closePaneById('p2')
    expect(panes()).toEqual(['p1[tab:0,*tab:1]'])
    openPlaceBeside(placeOf('chat', { chat: '/s/b.jsonl' }))
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p3[*tab:3]'])
  })

  it('takes chats and tools in any pane', () => {
    mount()
    moveTab('tab:1', 'p2')
    // A moved tab lands after the tab in front there.
    expect(panes()).toEqual(['p1[*tab:0]', 'p2[browser,*tab:1,files]'])
    moveTab('browser', 'p1')
    expect(panes()).toEqual(['p1[tab:0,*browser]', 'p2[*tab:1,files]'])
    const made = splitAt('p2', 'down', 'files')
    expect(panes()).toEqual(['p1[tab:0,*browser]', 'p2[*tab:1]', `${made}[*files]`])
  })

  it('the panel toggle maximizes the active app tab pane, and brings Browser and Files back', () => {
    mount()
    toggleToolPanes()
    expect(toolsShown(tilingStore.getState())).toBe(false)
    expect(tilingStore.getState().zoom).toBe('p1')
    expect(tabVisible('browser')).toBe(false)
    // A tool opened elsewhere ends the zoom.
    openTab({ kind: 'files' })
    expect(tilingStore.getState().zoom).toBeNull()
    closePaneById('p2')
    toggleToolPanes(true)
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p3[*browser,files]'])
  })

  it('never closes the pane holding every app tab', () => {
    mount()
    expect(() => closePaneById('p1')).toThrow('cannot close')
    runAction('close-pane')
    expect(panes()).toHaveLength(2)
  })

  it('runs the pane shortcuts', () => {
    mount()
    api.getPanel('browser')!.api.setActive()
    runAction('split-right')
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[*files]', 'p3[*browser]'])
    runAction('zoom-pane')
    expect(tilingStore.getState().zoom).toBe('p3')
    runAction('zoom-pane')
    expect(tilingStore.getState().zoom).toBeNull()
    runAction('new-tab')
    expect(panes()[0]).toBe('p1[tab:0,tab:1,*tab:2]')
    runAction('close-tab')
    expect(panes()[0]).toBe('p1[tab:0,*tab:1]')
  })

  it('a browser tab new in the scope in front brings the browser forward; other scopes do not', () => {
    mount()
    api.getPanel('files')!.api.setActive()
    enterScope('chat:/a')
    reportScopeTabs('chat:/a', ['t1'])
    expect(tabVisible('files')).toBe(true)
    reportScopeTabs('chat:/b', ['t2', 't3'])
    expect(tabVisible('files')).toBe(true)
    reportScopeTabs('chat:/a', ['t1', 't4'])
    expect(tabVisible('browser')).toBe(true)
    // A renamed draft scope keeps its tabs, so only a really new tab reveals.
    enterScope('draft:1')
    reportScopeTabs('draft:1', ['t9'])
    api.getPanel('files')!.api.setActive()
    renameScope('draft:1', 'chat:/c')
    reportScopeTabs('chat:/c', ['t9'])
    expect(tabVisible('files')).toBe(true)
  })

  it('navigates the active app tab in place', () => {
    mount()
    navigateTo(placeOf('jobs'))
    expect(panes()[0]).toBe('p1[tab:0,*tab:1]')
    expect(tabsStore.getState().tabs.list[1]!.here.page).toBe('jobs')
  })
})
