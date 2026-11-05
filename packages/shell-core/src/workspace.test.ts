import { describe, expect, it } from 'vitest'
import { dockGroups, dockShape, pageTab, toolTabId, type DockJson, type DockShape } from './dock'
import { placeOf, type Place } from './place'
import { createTabs, type Tab } from './tabs'
import {
  WORKSPACE_CAP,
  composeWorkspace,
  migrateWindowLayout,
  ownLayout,
  readWorkspaces,
  routeTo,
  saveWorkspaces,
  workspaceHome,
  workspaceOf,
} from './workspace'

const BOX = { width: 1200, height: 800 }
const title = (id: string): string => id
const tab = (id: number, place: Place, pinned = false): Tab => ({
  id,
  here: place,
  back: [],
  forward: [],
  pinned,
})
const chat = (file: string): Place => placeOf('chat', { chat: file })
/** /s/owned-*.jsonl sessions are Astra's. */
const ownerOf = (file: string): string | null => (file.startsWith('/s/owned') ? 'astra' : null)
const wsOf = (t: Tab): string => workspaceOf(t.here, t.id, ownerOf)

function brief(s: DockShape): unknown {
  return s.type === 'pane' ? `${s.id}[${s.views.join(',')}]` : { [s.dir]: s.children.map(brief) }
}

describe('workspaceOf', () => {
  it('puts an assistant thread and the sessions it owns in one workspace', () => {
    expect(workspaceOf(placeOf('agent:astra'), 0, ownerOf)).toBe('page:agent:astra')
    expect(workspaceOf(chat('/s/owned-1.jsonl'), 1, ownerOf)).toBe('page:agent:astra')
    expect(workspaceOf(chat('/s/plain.jsonl'), 2, ownerOf)).toBe('chat:/s/plain.jsonl')
    expect(workspaceOf(placeOf('chat'), 7, ownerOf)).toBe('draft:7')
  })
  it('gives a page one workspace whatever board, section or item it shows', () => {
    expect(workspaceOf(placeOf('canvas', { canvas: 'a' }), 0, ownerOf)).toBe('page:canvas')
    expect(workspaceOf(placeOf('canvas', { canvas: 'b' }), 0, ownerOf)).toBe('page:canvas')
    expect(workspaceOf(placeOf('review:pr:o/r#1'), 0, ownerOf)).toBe('page:reviews')
    expect(workspaceOf(placeOf('settings', { settingsSection: 'Chat' }), 0, ownerOf)).toBe(
      'page:settings',
    )
  })
  it('knows what an empty workspace opens on', () => {
    expect(workspaceHome('page:agent:nova')).toEqual(placeOf('agent:nova'))
    expect(workspaceHome('chat:/s/a.jsonl')).toEqual(chat('/s/a.jsonl'))
    expect(workspaceHome('page:jobs')).toEqual(placeOf('jobs'))
    expect(workspaceHome('nope')).toBeNull()
  })
})

describe('routeTo', () => {
  const tabs = createTabs(
    [tab(0, placeOf('agent:astra'), true), tab(1, placeOf('agent:nova')), tab(2, chat('/s/plain.jsonl'))],
    1,
  )
  it('brings an open tab forward instead of moving the one in front', () => {
    const next = routeTo(tabs, chat('/s/plain.jsonl'), { wsOf, front: 'page:agent:nova' })
    expect(next.list.map((t) => t.id)).toEqual([0, 1, 2])
    expect(next.list[next.active]!.id).toBe(2)
    expect(next.list[1]!.here).toEqual(placeOf('agent:nova'))
  })
  it("opens an owned session as a tab of its assistant's workspace", () => {
    const astra = routeTo(tabs, placeOf('agent:astra'), { wsOf, front: 'page:agent:nova' })
    expect(astra.list[astra.active]!.id).toBe(0)
    const owned = routeTo(astra, chat('/s/owned-1.jsonl'), { wsOf, front: 'page:agent:astra' })
    expect(owned.list.map((t) => t.id)).toEqual([0, 3, 1, 2])
    expect(owned.list[owned.active]!.here).toEqual(chat('/s/owned-1.jsonl'))
    // Astra's thread is still there, unchanged.
    expect(owned.list[0]!.here).toEqual(placeOf('agent:astra'))
  })
  it('opens a new workspace in a new tab, leaving the tab it came from as it was', () => {
    const next = routeTo(tabs, chat('/s/other.jsonl'), { wsOf, front: 'page:agent:nova' })
    expect(next.list).toHaveLength(4)
    expect(next.list[next.active]!.here).toEqual(chat('/s/other.jsonl'))
    expect(next.list[1]!.here).toEqual(placeOf('agent:nova'))
    expect(next.list[1]!.back).toEqual([])
  })
  it('takes the tab in front along when its workspace is nothing but that tab', () => {
    const plain = createTabs([tab(1, chat('/s/a.jsonl'))], 0)
    const next = routeTo(plain, chat('/s/b.jsonl'), {
      wsOf,
      front: 'chat:/s/a.jsonl',
      reuse: true,
    })
    expect(next.list).toHaveLength(1)
    expect(next.list[0]!.here).toEqual(chat('/s/b.jsonl'))
    expect(next.list[0]!.back).toEqual([chat('/s/a.jsonl')])
    // Never into a workspace that has a tab already, and never out of a pinned tab.
    const pinned = createTabs([tab(1, chat('/s/a.jsonl'), true)], 0)
    expect(routeTo(pinned, chat('/s/b.jsonl'), { wsOf, front: 'chat:/s/a.jsonl', reuse: true }).list).toHaveLength(2)
  })
  it("navigates a page workspace's own tab, with history", () => {
    const withCanvas = createTabs([...tabs.list, tab(3, placeOf('canvas', { canvas: 'a' }))], 1)
    const next = routeTo(withCanvas, placeOf('canvas', { canvas: 'b' }), {
      wsOf,
      front: 'page:agent:nova',
    })
    expect(next.list).toHaveLength(4)
    const canvas = next.list[next.active]!
    expect(canvas.id).toBe(3)
    expect(canvas.here.canvas).toBe('b')
    expect(canvas.back.map((p) => p.canvas)).toEqual(['a'])
  })
})

describe('composeWorkspace', () => {
  const tabs = createTabs(
    [tab(0, placeOf('agent:astra'), true), tab(1, placeOf('agent:nova')), tab(2, chat('/s/plain.jsonl'))],
    1,
  )
  const files = { kind: 'files' } as const
  it('starts a workspace with its tab, the pinned tabs and the pinned tools on the right', () => {
    const json = composeWorkspace(null, {
      tabs,
      ws: 'chat:/s/plain.jsonl',
      wsOf,
      pinned: [files],
      box: BOX,
      titles: title,
    })!
    expect(brief(dockShape(json))).toEqual({ row: ['p1[tab:0,tab:2]', 'p2[files]'] })
    expect(json.grid.root.type === 'branch' && json.grid.root.data.map((c) => c.size)).toEqual([
      792, 408,
    ])
  })
  it("drops another workspace's tabs from a saved layout and keeps its own panes", () => {
    const saved = composeWorkspace(null, {
      tabs,
      ws: 'page:agent:nova',
      wsOf,
      pinned: [{ kind: 'terminal' }],
      box: BOX,
      titles: title,
    })!
    dockGroups(saved.grid.root)[0]!.views.push('tab:2')
    const json = composeWorkspace(saved, {
      tabs,
      ws: 'page:agent:nova',
      wsOf,
      pinned: [files],
      box: BOX,
      titles: title,
    })!
    // Terminal was pinned when it saved; now Files is, and it leads the tool pane.
    expect(brief(dockShape(json))).toEqual({ row: ['p1[tab:0,tab:1]', 'p2[files,terminal]'] })
  })
  it('has nothing to show for a workspace without a tab', () => {
    const none = composeWorkspace(null, {
      tabs: createTabs([tab(1, placeOf('agent:nova'))], 0),
      ws: 'page:jobs',
      wsOf,
      pinned: [],
      box: BOX,
      titles: title,
    })
    expect(none).toBeNull()
  })

  it("puts another workspace's shortcut in the first pane of app tabs, not the active tab's", () => {
    const canvas = (slug: string) => placeOf('canvas', { canvas: slug })
    const both = createTabs(
      [tab(0, placeOf('agent:astra'), true), tab(1, canvas('a')), tab(2, canvas('b'))],
      2,
    )
    const saved = composeWorkspace(null, {
      tabs: both,
      ws: 'page:canvas',
      wsOf,
      pinned: [],
      box: BOX,
      titles: title,
    })!
    // Board b was dragged into a pane of its own on the right; the layout saved without Astra.
    const own = {
      ...saved,
      grid: {
        ...saved.grid,
        root: {
          type: 'branch' as const,
          size: 800,
          data: [
            { type: 'leaf' as const, size: 600, data: { id: 'p1', views: ['tab:1'] } },
            { type: 'leaf' as const, size: 600, data: { id: 'p2', views: ['tab:2'], activeView: 'tab:2' } },
          ],
        },
      },
    }
    const json = composeWorkspace(own, {
      tabs: both,
      ws: 'page:canvas',
      wsOf,
      pinned: [],
      box: BOX,
      titles: title,
    })!
    expect(brief(dockShape(json))).toEqual({ row: ['p1[tab:0,tab:1]', 'p2[tab:2]'] })
  })
})

describe('ownLayout', () => {
  it('leaves pinned tabs out and keeps the maximized pane', () => {
    const json: DockJson = {
      grid: {
        root: {
          type: 'branch',
          size: 800,
          data: [
            { type: 'leaf', size: 600, data: { id: 'p1', views: ['tab:0', 'tab:1'], activeView: 'tab:0' } },
            { type: 'leaf', size: 300, data: { id: 'p2', views: ['files'] } },
            { type: 'leaf', size: 300, data: { id: 'p3', views: ['terminal'] } },
          ],
        },
        width: 1200,
        height: 800,
        orientation: 'HORIZONTAL',
        maximizedNode: { location: [2] },
      },
      panels: {},
      activeGroup: 'p2',
    }
    const own = ownLayout(json, (id) => id === 'tab:0' || id === 'files')!
    expect(brief(dockShape(own))).toEqual({ row: ['p1[tab:1]', 'p3[terminal]'] })
    expect(dockGroups(own.grid.root)[0]!.activeView).toBe('tab:1')
    expect(own.grid.maximizedNode).toEqual({ location: [1] })
    expect(own.activeGroup).toBe('p1')
  })
})

describe('migrateWindowLayout', () => {
  it("makes the window's layout the front workspace's, a page beside it one of its tabs", () => {
    // Isaac's window on 2026-11-05: Astra pinned and Nova in one pane, Browser and a board beside.
    const tabs = createTabs(
      [
        tab(0, placeOf('agent:astra'), true),
        tab(44, placeOf('agent:nova')),
        tab(64, placeOf('canvas', { canvas: 'skills' })),
      ],
      1,
    )
    const dock: DockJson = {
      grid: {
        root: {
          type: 'branch',
          size: 1018,
          data: [
            { type: 'leaf', size: 1518, data: { id: 'p77', views: ['tab:0', 'tab:44'], activeView: 'tab:44' } },
            { type: 'leaf', size: 1886, data: { id: 'p89', views: ['browser', 'tab:64'], activeView: 'tab:64' } },
          ],
        },
        width: 3412,
        height: 1018,
        orientation: 'HORIZONTAL',
      },
      panels: {
        'tab:0': { id: 'tab:0', contentComponent: 'app', title: 'Astra' },
        'tab:44': { id: 'tab:44', contentComponent: 'app', title: 'Nova' },
        browser: { id: 'browser', contentComponent: 'tool', params: { tab: { kind: 'browser' } } },
        'tab:64': { id: 'tab:64', contentComponent: 'app', title: 'Skills' },
      },
    }
    const out = migrateWindowLayout(dock, tabs, wsOf, 'page:agent:nova')
    const view = toolTabId(pageTab(placeOf('canvas', { canvas: 'skills' })))
    expect(view).toBe('view:canvas:skills')
    expect(out.tabs.list.map((t) => t.id)).toEqual([0, 44])
    expect(out.tabs.list[out.tabs.active]!.id).toBe(44)
    const json = composeWorkspace(out.layout, {
      tabs: out.tabs,
      ws: 'page:agent:nova',
      wsOf,
      pinned: [],
      box: BOX,
      titles: title,
    })!
    expect(brief(dockShape(json))).toEqual({
      row: ['p77[tab:0,tab:44]', `p89[browser,${view}]`],
    })
    expect(dockGroups(json.grid.root)[1]!.activeView).toBe(view)
  })
})

describe('the saved record', () => {
  const layout = (n: number): DockJson => ({
    grid: {
      root: { type: 'branch', size: 1, data: [{ type: 'leaf', size: 1, data: { id: `p${n}`, views: [] } }] },
      width: 1,
      height: 1,
      orientation: 'HORIZONTAL',
    },
    panels: {},
  })
  it('reads back what it saves, pinned tools deduplicated', () => {
    const saved = saveWorkspaces({
      front: 'page:agent:nova',
      pinned: [{ kind: 'files' }],
      layouts: { 'page:agent:nova': layout(1) },
      order: ['page:agent:nova'],
    })
    const read = readWorkspaces({ ...saved, pinned: [{ kind: 'files' }, { kind: 'files' }, 'x'] })
    expect(read).toEqual({
      front: 'page:agent:nova',
      pinned: [{ kind: 'files' }],
      layouts: { 'page:agent:nova': layout(1) },
      order: ['page:agent:nova'],
    })
    expect(readWorkspaces({ v: 2 })).toBeNull()
  })
  it('drops the oldest chat and page layouts past the cap, never an assistant', () => {
    const layouts: Record<string, DockJson> = { 'page:agent:astra': layout(0) }
    const order: string[] = []
    for (let i = 0; i < WORKSPACE_CAP + 5; i++) {
      layouts[`chat:/s/${i}.jsonl`] = layout(i)
      order.push(`chat:/s/${i}.jsonl`)
    }
    order.push('page:agent:astra')
    const saved = saveWorkspaces({ front: null, pinned: [], layouts, order })
    const kept = Object.keys(saved['layouts'] as object)
    expect(kept).toHaveLength(WORKSPACE_CAP + 1)
    expect(kept).toContain('page:agent:astra')
    expect(kept).not.toContain(`chat:/s/${WORKSPACE_CAP}.jsonl`)
  })
})
