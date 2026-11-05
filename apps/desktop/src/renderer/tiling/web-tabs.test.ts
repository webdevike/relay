import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
const handlers = new Map<string, (p: unknown) => void>()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: (channel: string, fn: (p: unknown) => void) => {
    handlers.set(channel, fn)
    return () => handlers.delete(channel)
  },
}))

import { createDockview, type DockviewApi } from 'dockview-react'
import { createTabs, placeOf, type Place, type Tab } from '@evaos/shell-core'
import type { TabState } from '@evaos/contract'
import { browserStore } from '../browser/browser-store'
import { runAction } from '../hotkeys/router'
import { navigateTo, resetTabsForTests, tabsStore } from '../tabs/tabs-store'
import { setOwnerResolver } from '../tabs/workspace-of'
import {
  applySavedLayout,
  attachDock,
  focusPaneById,
  nextGroupId,
  resetTilingForTests,
  startTiling,
  tilingStore,
} from './tiling-store'
import { openWebPage, startWebTabs } from './web-tabs'

const tab = (id: number, here: Place, pinned = false): Tab => ({
  id,
  here,
  back: [],
  forward: [],
  pinned,
})
const NOVA = placeOf('agent:nova')
const ASTRA = placeOf('agent:astra')

const page = (id: string, extra: Partial<TabState> = {}): TabState => ({
  id,
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  blank: true,
  error: null,
  favicon: null,
  pinned: false,
  ...extra,
})

/** Each pane as `id[views]`, in layout order, the one in front starred. */
const panes = (): string[] =>
  tilingStore
    .getState()
    .panes.map((p) => `${p.id}[${p.views.map((v) => (v === p.active ? `*${v}` : v)).join(',')}]`)

const created = (): Array<Record<string, unknown>> =>
  invoke.mock.calls.filter((c) => c[0] === 'browser.createTab').map((c) => c[1])

let next = 0
let stop: () => void
let stopWeb: (() => void) | null = null
let api: DockviewApi
let detach: () => void
let host: HTMLDivElement

function mount(saved: { workspaces?: unknown } = {}): void {
  tabsStore.setState(
    { tabs: createTabs([tab(0, ASTRA, true), tab(1, NOVA)], 1), loaded: true },
    true,
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  api = createDockview(host, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
    disableFloatingGroups: true,
    groupIdGenerator: nextGroupId,
  })
  api.layout(1200, 800)
  detach = attachDock(api, host)
  applySavedLayout({
    dock: null,
    tiling: null,
    workspaces: saved.workspaces ?? null,
    legacy: null,
    sidebarWidth: 272,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  next = 0
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string, input: Record<string, unknown>) => {
    if (channel === 'browser.createTab') {
      next += 1
      return {
        ok: true,
        value: page(`t${next}`, input['url'] ? { url: String(input['url']), blank: false } : {}),
      }
    }
    return { ok: true, value: {} }
  })
  resetTabsForTests()
  resetTilingForTests()
  browserStore.setState({ tabs: [], activeId: '', scope: '', byId: {}, wantAddress: null })
  setOwnerResolver(() => null)
  stop = startTiling()
})
afterEach(() => {
  stopWeb?.()
  stopWeb = null
  stop()
  detach()
  api.dispose()
  host.remove()
  vi.useRealTimers()
})

describe('openWebPage', () => {
  it('opens right of the chat, then beside the other pages; a background page waits behind', async () => {
    mount()
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[*files]'])
    const first = await openWebPage({ url: 'https://a.test/' })
    expect(first).toEqual({ pane: 'p3', tab: 'web:t1', tabId: 't1' })
    // Split right of the chat: between it and the Files pane on screen.
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[*files]', 'p3[*web:t1]'])
    expect(tilingStore.getState().panes.find((p) => p.id === 'p3')!.rect!.x).toBeLessThan(
      tilingStore.getState().panes.find((p) => p.id === 'p2')!.rect!.x,
    )
    expect(tilingStore.getState().focus).toBe('p3')
    await openWebPage({ url: 'https://b.test/' })
    expect(panes()[2]).toBe('p3[web:t1,*web:t2]')
    focusPaneById('p1')
    await openWebPage({ url: 'https://c.test/', background: true })
    expect(panes()[2]).toBe('p3[web:t1,*web:t2,web:t3]')
    expect(tilingStore.getState().focus).toBe('p1')
    expect(created()).toEqual([
      { url: 'https://a.test/', scope: 'page:agent:nova' },
      { url: 'https://b.test/', scope: 'page:agent:nova' },
      { url: 'https://c.test/', scope: 'page:agent:nova', background: true },
    ])
  })

  it('goes into a named pane, or a split beside the focused one; a blank page wants its address', async () => {
    mount()
    await openWebPage({ pane: 'p2' })
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[files,*web:t1]'])
    expect(browserStore.getState().wantAddress).toBe('t1')
    focusPaneById('p2')
    const split = await openWebPage({ url: 'https://d.test/', split: 'down' })
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[files,*web:t1]', `${split.pane}[*web:t2]`])
    expect(tilingStore.getState().focus).toBe(split.pane)
  })

  it('lands in a workspace not on screen without touching the one that is', async () => {
    mount()
    const before = panes()
    await openWebPage({ url: 'https://e.test/', scope: 'page:agent:astra', openedBy: 'Fix login' })
    expect(panes()).toEqual(before)
    expect(tilingStore.getState().scope).toBe('page:agent:nova')
    expect(created().at(-1)).toEqual({
      url: 'https://e.test/',
      scope: 'page:agent:astra',
      openedBy: 'Fix login',
    })
    navigateTo(ASTRA)
    expect(panes()).toEqual(['p1[*tab:0]', expect.stringMatching(/^p\d+\[\*web:t1\]$/)])
  })
})

describe('startWebTabs', () => {
  it("shows a page's popup right after it; a Cmd-click one in the background", async () => {
    mount()
    await openWebPage({ url: 'https://a.test/' })
    await openWebPage({ url: 'https://b.test/' })
    stopWeb = startWebTabs()
    handlers.get('browser.popup')!({ tabId: 't7', openerId: 't1', scope: 'page:agent:nova' })
    expect(panes()[2]).toBe('p3[web:t1,*web:t7,web:t2]')
    handlers.get('browser.popup')!({
      tabId: 't8',
      openerId: 't1',
      scope: 'page:agent:nova',
      background: true,
    })
    expect(panes()[2]).toBe('p3[web:t1,web:t8,*web:t7,web:t2]')
    // An extension's page (no opener) joins the workspace's pages.
    handlers.get('browser.popup')!({ tabId: 't9', scope: 'page:agent:nova' })
    expect(panes()[2]).toBe('p3[web:t1,web:t8,web:t7,*web:t9,web:t2]')
  })

  it('makes the page tab in front of the focused pane the active page, and drops closed pages', async () => {
    mount()
    stopWeb = startWebTabs()
    await openWebPage({ url: 'https://a.test/' })
    expect(invoke).toHaveBeenCalledWith('browser.activateTab', { tabId: 't1' })
    const snap = (tabs: TabState[]) =>
      browserStore.getState().set({ tabs, activeId: 't1', scope: 'page:agent:nova' })
    snap([page('t1', { blank: false })])
    // An extension (or Cmd+W in the page) closed it: its tab goes too.
    snap([])
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[*files]'])
  })

  it('turns a saved Browser panel into page tabs once the panes are built', async () => {
    const dock = {
      grid: {
        root: {
          type: 'branch',
          size: 800,
          data: [
            {
              type: 'leaf',
              size: 700,
              data: { id: 'p1', views: ['tab:0', 'tab:1'], activeView: 'tab:1' },
            },
            {
              type: 'leaf',
              size: 500,
              data: { id: 'p2', views: ['browser', 'files'], activeView: 'browser' },
            },
          ],
        },
        width: 1200,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: {
        'tab:0': { id: 'tab:0', contentComponent: 'app', tabComponent: 'app', params: {} },
        'tab:1': { id: 'tab:1', contentComponent: 'app', tabComponent: 'app', params: {} },
        browser: {
          id: 'browser',
          contentComponent: 'tool',
          tabComponent: 'tool',
          params: { tab: { kind: 'browser' } },
        },
        files: {
          id: 'files',
          contentComponent: 'tool',
          tabComponent: 'tool',
          params: { tab: { kind: 'files' } },
        },
      },
    }
    invoke.mockImplementation(async (channel: string) =>
      channel === 'browser.state'
        ? {
            ok: true,
            value: {
              tabs: [page('t3', { title: 'Docs', blank: false }), page('t4', { blank: false })],
              activeId: 't3',
              scope: 'page:agent:nova',
            },
          }
        : { ok: true, value: {} },
    )
    mount({
      workspaces: {
        v: 1,
        front: 'page:agent:nova',
        pinned: [],
        layouts: { 'page:agent:nova': dock },
        order: ['page:agent:nova'],
      },
    })
    stopWeb = startWebTabs()
    await vi.waitFor(() => expect(panes()[1]).toBe('p2[*web:t3,web:t4,files]'))
    expect(invoke).toHaveBeenCalledWith('browser.state', { scope: 'page:agent:nova' })
  })
})

describe('Cmd+T', () => {
  it('opens a blank page in the focused pane', async () => {
    mount()
    focusPaneById('p2')
    runAction('new-tab')
    await vi.waitFor(() => expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[files,*web:t1]']))
    expect(created()).toEqual([{ scope: 'page:agent:nova' }])
    expect(browserStore.getState().wantAddress).toBe('t1')
  })
})
