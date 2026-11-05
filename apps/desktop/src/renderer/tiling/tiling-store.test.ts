import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: () => () => {},
}))

import { createDockview, type DockviewApi } from 'dockview-react'
import { createTabs, placeOf, type Place, type Tab } from '@evaos/shell-core'
import { runAction } from '../hotkeys/router'
import { saveDraft } from '../chat/drafts'
import { navigateTo, newChatTab, resetTabsForTests, tabsStore } from '../tabs/tabs-store'
import { setOwnerResolver } from '../tabs/workspace-of'
import {
  applySavedLayout,
  attachDock,
  closeAppTab,
  closePaneById,
  closeTab,
  dropAllowed,
  inWorkspace,
  layoutShape,
  moveTab,
  nextGroupId,
  openPlaceBeside,
  openTab,
  renameScope,
  replaceLegacyBrowser,
  resetTilingForTests,
  setPinned,
  splitAt,
  startTiling,
  tabVisible,
  tilingStore,
  toggleToolPanes,
  toolsShown,
} from './tiling-store'

const tab = (id: number, here: Place, pinned = false): Tab => ({
  id,
  here,
  back: [],
  forward: [],
  pinned,
})
const chat = (file: string): Place => placeOf('chat', { chat: file })
const NOVA = placeOf('agent:nova')
const ASTRA = placeOf('agent:astra')

/** Each pane as `id[views]`, in layout order, the one in front starred. */
const panes = (): string[] =>
  tilingStore
    .getState()
    .panes.map((p) => `${p.id}[${p.views.map((v) => (v === p.active ? `*${v}` : v)).join(',')}]`)

const saves = (): Array<Record<string, unknown>> =>
  invoke.mock.calls
    .filter((c) => c[0] === 'layout.save' && (c[1] as { workspaces?: unknown }).workspaces)
    .map((c) => c[1] as Record<string, unknown>)

const ws = (): string => tilingStore.getState().scope
const activeId = (): number => {
  const t = tabsStore.getState().tabs
  return t.list[t.active]!.id
}

let stop: () => void
let api: DockviewApi
let detach: () => void
let host: HTMLDivElement

function mount(
  saved: { dock?: unknown; tiling?: unknown; workspaces?: unknown } = {},
  list: Tab[] = [tab(0, ASTRA, true), tab(1, NOVA), tab(2, chat('/s/a.jsonl'))],
  active = 1,
): void {
  tabsStore.setState({ tabs: createTabs(list, active), loaded: true }, true)
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
    dock: saved.dock ?? null,
    tiling: saved.tiling ?? null,
    workspaces: saved.workspaces ?? null,
    legacy: null,
    sidebarWidth: 272,
  })
}

function unmount(): void {
  detach()
  api.dispose()
  host.remove()
}

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: {} })
  resetTabsForTests()
  resetTilingForTests()
  setOwnerResolver((file) => (file.startsWith('/s/owned') ? 'nova' : null))
  stop = startTiling()
})
afterEach(() => {
  stop()
  unmount()
  setOwnerResolver(() => null)
  vi.useRealTimers()
})

describe('workspaces', () => {
  it("first launch: the window's layout becomes the front workspace's and saves at once", () => {
    mount()
    expect(ws()).toBe('page:agent:nova')
    // Astra is pinned (a shortcut in every workspace); the plain chat is a workspace of its own.
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[*files]'])
    expect(saves()).toHaveLength(1)
    const saved = saves()[0]!['workspaces'] as { layouts: Record<string, unknown>; front: string }
    expect(saved.front).toBe('page:agent:nova')
    expect(Object.keys(saved.layouts)).toEqual(['page:agent:nova'])
  })

  it('switching swaps the whole layout and switching back restores it exactly', () => {
    mount()
    openTab({ kind: 'terminal' })
    const p3 = splitAt('p2', 'down', 'files', 0.3)
    api.getPanel('terminal')!.api.setActive()
    const before = { panes: panes(), shape: layoutShape() }
    navigateTo(chat('/s/a.jsonl'))
    expect(ws()).toBe('chat:/s/a.jsonl')
    expect(panes()).toEqual(['p1[tab:0,*tab:2]'])
    expect(tabVisible('terminal')).toBe(false)
    navigateTo(NOVA)
    expect(ws()).toBe('page:agent:nova')
    expect(panes()).toEqual(before.panes)
    expect(panes()).toContain(`${p3}[*files]`)
    expect(layoutShape()).toEqual(before.shape)
    // The plain chat had nothing but its tab: that tab closed (it reopens on return).
    expect(tabsStore.getState().tabs.list.map((t) => t.id)).toEqual([0, 1])
  })

  it('restores saved workspaces without writing them back', () => {
    mount()
    openTab({ kind: 'terminal' })
    splitAt('p2', 'down', 'files')
    vi.advanceTimersByTime(1000)
    const last = saves().at(-1)!
    unmount()
    stop()
    resetTilingForTests()
    invoke.mockClear()
    stop = startTiling()
    mount({ dock: last['dock'], workspaces: JSON.parse(JSON.stringify(last['workspaces'])) })
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[*terminal]', 'p3[*files]'])
    vi.advanceTimersByTime(1000)
    expect(saves()).toHaveLength(0)
  })

  it("migrates Isaac's window: a board beside Nova becomes Nova's page tab", () => {
    const dock = {
      grid: {
        root: {
          type: 'branch',
          size: 800,
          data: [
            { type: 'leaf', size: 700, data: { id: 'p77', views: ['tab:0', 'tab:44'], activeView: 'tab:44' } },
            { type: 'leaf', size: 500, data: { id: 'p89', views: ['browser', 'tab:64'], activeView: 'tab:64' } },
          ],
        },
        width: 1200,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: {
        'tab:0': { id: 'tab:0', contentComponent: 'app', tabComponent: 'app', params: {} },
        'tab:44': { id: 'tab:44', contentComponent: 'app', tabComponent: 'app', params: {} },
        browser: {
          id: 'browser',
          contentComponent: 'tool',
          tabComponent: 'tool',
          params: { tab: { kind: 'browser' } },
        },
        'tab:64': { id: 'tab:64', contentComponent: 'app', tabComponent: 'app', params: {} },
      },
    }
    mount({ dock }, [tab(0, ASTRA, true), tab(44, NOVA), tab(64, placeOf('canvas', { canvas: 'skills' }))], 1)
    expect(panes()).toEqual(['p77[tab:0,*tab:44]', 'p89[browser,*view:canvas:skills]'])
    expect(tabsStore.getState().tabs.list.map((t) => t.id)).toEqual([0, 44])
    // Astra starts with her thread and nothing else.
    navigateTo(ASTRA)
    expect(panes()).toEqual(['p1[*tab:0]'])
  })

  it('turns the retired Browser panel into one page tab per page, where it stood', () => {
    const dock = {
      grid: {
        root: {
          type: 'branch',
          size: 800,
          data: [
            { type: 'leaf', size: 700, data: { id: 'p1', views: ['tab:0', 'tab:1'], activeView: 'tab:1' } },
            { type: 'leaf', size: 500, data: { id: 'p2', views: ['files', 'browser'], activeView: 'browser' } },
          ],
        },
        width: 1200,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: {
        'tab:0': { id: 'tab:0', contentComponent: 'app', tabComponent: 'app', params: {} },
        'tab:1': { id: 'tab:1', contentComponent: 'app', tabComponent: 'app', params: {} },
        files: { id: 'files', contentComponent: 'tool', tabComponent: 'tool', params: { tab: { kind: 'files' } } },
        browser: { id: 'browser', contentComponent: 'tool', tabComponent: 'tool', params: { tab: { kind: 'browser' } } },
      },
    }
    const astra = JSON.parse(JSON.stringify(dock)) as typeof dock
    astra.grid.root.data[0]!.data = { id: 'p1', views: ['tab:0'], activeView: 'tab:0' }
    delete (astra.panels as Record<string, unknown>)['tab:1']
    const workspaces = {
      v: 1,
      front: 'page:agent:nova',
      pinned: [],
      layouts: { 'page:agent:nova': dock, 'page:agent:astra': astra, 'page:jobs': astra },
      order: ['page:agent:nova', 'page:agent:astra', 'page:jobs'],
    }
    mount({ workspaces })
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[files,*browser]'])
    // On screen: the Browser was in front, so its active page is.
    replaceLegacyBrowser(
      'page:agent:nova',
      [
        { id: 't9', pinned: true },
        { id: 't1', pinned: false },
        { id: 't2', pinned: false },
      ],
      't2',
    )
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[files,web:t9,web:t1,*web:t2]'])
    // A page pinned in the browser is a pinned page tab, in every workspace.
    expect(tilingStore.getState().pinned).toEqual([{ kind: 'web', id: 't9' }])
    expect(invoke).not.toHaveBeenCalledWith('browser.pinTab', expect.anything())
    // Not on screen: its saved layout changes, its own pages in order.
    replaceLegacyBrowser('page:agent:astra', [{ id: 't5', pinned: false }, { id: 't6', pinned: false }], 't6')
    // No page: the panel just goes.
    replaceLegacyBrowser('page:jobs', [], '')
    navigateTo(ASTRA)
    // The pinned page joins every workspace's first tool pane, pinned tabs first.
    expect(panes()).toEqual(['p1[*tab:0]', 'p2[web:t9,files,web:t5,*web:t6]'])
    navigateTo(placeOf('jobs'))
    expect(panes()[1]).toBe('p2[web:t9,*files]')
  })

  it('opens an owned session inside its assistant workspace, as a tab beside the thread', () => {
    mount()
    navigateTo(chat('/s/owned-1.jsonl'))
    expect(ws()).toBe('page:agent:nova')
    expect(panes()).toEqual(['p1[tab:0,tab:1,*tab:3]', 'p2[*files]'])
  })

  it("a chat's lone tab goes on to the next chat; its panes wait for it, chat pane and all", () => {
    mount()
    navigateTo(chat('/s/a.jsonl'))
    const tabA = activeId()
    openTab({ kind: 'terminal' })
    const before = panes()
    navigateTo(chat('/s/b.jsonl'))
    // The same tab, now on chat b (Back returns to a), with b's own (empty) panes.
    expect(activeId()).toBe(tabA)
    expect(ws()).toBe('chat:/s/b.jsonl')
    expect(panes()).toEqual([`p1[tab:0,*tab:${tabA}]`])
    // Chat a comes back in its old pane, Terminal beside it.
    navigateTo(chat('/s/a.jsonl'))
    expect(panes()).toEqual(before.map((p) => p.replace(`tab:${tabA}`, `tab:${activeId()}`)))
  })

  it('a new chat starts with just the pinned tabs', () => {
    mount()
    setPinned('files', true)
    newChatTab()
    expect(ws()).toBe(`draft:${activeId()}`)
    expect(panes()).toEqual([`p1[tab:0,*tab:${activeId()}]`, 'p2[*files]'])
    // Its draft gets a file: the workspace follows it, panes and all.
    renameScope(ws(), 'chat:/s/new.jsonl')
    expect(ws()).toBe('chat:/s/new.jsonl')
  })

  it('pins a tool tab to every workspace; unpinned, it stays only where it was', () => {
    mount()
    setPinned('files', true)
    navigateTo(chat('/s/a.jsonl'))
    expect(panes()).toEqual(['p1[tab:0,*tab:2]', 'p2[*files]'])
    // Opening Terminal beside it keeps it in this workspace only.
    openTab({ kind: 'terminal' })
    setPinned('files', false)
    navigateTo(NOVA)
    expect(panes()).toEqual(['p1[tab:0,*tab:1]'])
    navigateTo(chat('/s/a.jsonl'))
    expect(panes()).toEqual(['p1[tab:0,*tab:2]', 'p2[files,*terminal]'])
  })

  it('never puts two workspaces side by side', () => {
    mount()
    // Astra's pinned tab only moves within its own strip.
    expect(dropAllowed('tab:0', 'p2', 'content')).toBe(false)
    expect(dropAllowed('tab:0', 'p1', 'tab')).toBe(true)
    expect(dropAllowed('tab:1', 'p2', 'content')).toBe(true)
    expect(() => splitAt('p1', 'right', 'tab:0')).toThrow('side by side')
    // Another workspace's chat opened "beside" opens as its own workspace instead.
    openPlaceBeside(chat('/s/b.jsonl'))
    expect(ws()).toBe('chat:/s/b.jsonl')
    expect(panes()).toEqual([`p1[tab:0,*tab:${activeId()}]`])
  })

  it('opens a page beside the chat as a page tab of this workspace', () => {
    mount()
    openPlaceBeside(placeOf('studio'))
    expect(ws()).toBe('page:agent:nova')
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[files,*view:page:studio]'])
    expect(activeId()).toBe(1)
    closePaneById('p2')
    openPlaceBeside(placeOf('studio'))
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p3[*view:page:studio]'])
  })

  it("changes a workspace that is not on screen without touching the one that is", () => {
    mount()
    const before = panes()
    const pane = inWorkspace('page:agent:astra', () => openTab({ kind: 'terminal' }))
    expect(panes()).toEqual(before)
    expect(ws()).toBe('page:agent:nova')
    navigateTo(ASTRA)
    expect(panes()).toEqual(['p1[*tab:0]', `${pane}[*terminal]`])
    // A workspace with no tab yet gets its home tab, unseen until opened.
    const files = inWorkspace('chat:/s/c.jsonl', () => openTab({ kind: 'files' }))
    expect(ws()).toBe('page:agent:astra')
    navigateTo(chat('/s/c.jsonl'))
    expect(panes()).toEqual([`p1[tab:0,*tab:${activeId()}]`, `${files}[*files]`])
  })
})

describe('panes within a workspace', () => {
  it('follows the tabs store: closing keeps the focus in the pane', () => {
    mount()
    navigateTo(chat('/s/owned-1.jsonl'))
    expect(panes()[0]).toBe('p1[tab:0,tab:1,*tab:3]')
    closeAppTab(3)
    expect(panes()[0]).toBe('p1[tab:0,*tab:1]')
    expect(activeId()).toBe(1)
  })

  it('an empty new chat closes when left; one with text stays reachable from every workspace', () => {
    mount()
    newChatTab()
    const empty = activeId()
    navigateTo(NOVA)
    expect(tabsStore.getState().tabs.list.some((t) => t.id === empty)).toBe(false)
    newChatTab()
    const draft = activeId()
    saveDraft(`draft:${draft}`, 'half a thought')
    navigateTo(NOVA)
    // A shortcut in Nova's strip; it opens the draft's own workspace.
    expect(panes()[0]).toBe(`p1[tab:0,*tab:1,tab:${draft}]`)
    expect(dropAllowed(`tab:${draft}`, 'p2', 'content')).toBe(false)
    api.getPanel(`tab:${draft}`)!.api.setActive()
    expect(ws()).toBe(`draft:${draft}`)
    saveDraft(`draft:${draft}`, '')
  })

  it('takes chats and tools in any pane of the workspace', () => {
    mount()
    moveTab('tab:1', 'p2')
    expect(panes()).toEqual(['p1[*tab:0]', 'p2[files,*tab:1]'])
    moveTab('files', 'p1')
    expect(panes()).toEqual(['p1[tab:0,*files]', 'p2[*tab:1]'])
    const made = splitAt('p2', 'down', 'files')
    expect(panes()).toEqual(['p1[*tab:0]', 'p2[*tab:1]', `${made}[*files]`])
  })

  it('the panel toggle maximizes the chat pane, and brings Files back', () => {
    mount()
    toggleToolPanes()
    expect(toolsShown(tilingStore.getState())).toBe(false)
    expect(tilingStore.getState().zoom).toBe('p1')
    expect(tabVisible('files')).toBe(false)
    openTab({ kind: 'files' })
    expect(tilingStore.getState().zoom).toBeNull()
    closePaneById('p2')
    toggleToolPanes(true)
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p3[*files]'])
  })

  it("never closes the pane holding the workspace's chat", () => {
    mount()
    expect(() => closePaneById('p1')).toThrow('cannot close')
    runAction('close-pane')
    expect(panes()).toHaveLength(2)
  })

  it('runs the pane shortcuts', () => {
    mount()
    openTab({ kind: 'terminal' })
    runAction('split-right')
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[*files]', 'p3[*terminal]'])
    runAction('zoom-pane')
    expect(tilingStore.getState().zoom).toBe('p3')
    runAction('zoom-pane')
    expect(tilingStore.getState().zoom).toBeNull()
  })

  it('a page tab closes its page, and pinning one pins its page in the browser', () => {
    mount()
    openTab({ kind: 'web', id: 't4' })
    expect(panes()).toEqual(['p1[tab:0,*tab:1]', 'p2[files,*web:t4]'])
    setPinned('web:t4', true)
    expect(invoke).toHaveBeenCalledWith('browser.pinTab', { tabId: 't4', pinned: true })
    closeTab('web:t4')
    expect(invoke).toHaveBeenCalledWith('browser.closeTab', { tabId: 't4' })
    // Closing it unpinned it without asking the browser to (its page is gone).
    expect(tilingStore.getState().pinned).toEqual([])
    expect(invoke).not.toHaveBeenCalledWith('browser.pinTab', { tabId: 't4', pinned: false })
    openTab({ kind: 'web', id: 't5' })
    closePaneById('p2')
    expect(invoke).toHaveBeenCalledWith('browser.closeTab', { tabId: 't5' })
  })
})
