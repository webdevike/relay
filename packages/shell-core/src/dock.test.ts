import { describe, expect, it } from 'vitest'
import {
  appPanelId,
  appTabOf,
  defaultDock,
  dockGroups,
  dockShape,
  migrateTiling,
  neighbor,
  reconcileDock,
  shapeMinWidth,
  toolTabFromJson,
  toolTabId,
  type DockJson,
  type DockShape,
} from './dock'
import { MAIN_MIN } from './fit'
import { placeOf } from './place'
import { createTabs, type Tab } from './tabs'

const BOX = { width: 1200, height: 800 }
const title = (id: string): string => id
const tab = (id: number, page: Parameters<typeof placeOf>[0], extra = {}): Tab => ({
  id,
  here: placeOf(page, extra),
  back: [],
  forward: [],
  pinned: false,
})
const TABS = createTabs([tab(0, 'dashboard'), tab(1, 'chat', { chat: '/s/a.jsonl' })], 1)

/** A shape as nested ids: a pane is `id[views]`, a split is {dir: [...]}. */
function brief(s: DockShape): unknown {
  return s.type === 'pane' ? `${s.id}[${s.views.join(',')}]` : { [s.dir]: s.children.map(brief) }
}

describe('panels', () => {
  it('names app tabs and tool tabs, and reads tool tabs back', () => {
    expect(appPanelId(7)).toBe('tab:7')
    expect(appTabOf('tab:7')).toBe(7)
    expect(appTabOf('browser')).toBeNull()
    const sub = {
      kind: 'subagent',
      session: '/s/a.jsonl',
      file: '/s/a/x.jsonl',
      name: 'X',
    } as const
    expect(toolTabId(sub)).toBe('subagent:/s/a/x.jsonl')
    expect(toolTabFromJson(sub)).toEqual(sub)
    expect(toolTabFromJson({ kind: 'page' })).toBeNull()
    expect(toolTabFromJson({ kind: 'subagent', file: 'x' })).toBeNull()
    // The retired Browser panel still reads, so the load can turn it into page tabs.
    expect(toolTabFromJson({ kind: 'browser' })).toEqual({ kind: 'browser' })
    expect(toolTabId({ kind: 'browser' })).toBe('browser')
    expect(toolTabFromJson({ kind: 'web', id: 't4' })).toEqual({ kind: 'web', id: 't4' })
  })
})

describe('defaultDock', () => {
  it('puts the app tabs left and Files right at the tool share', () => {
    const d = defaultDock(TABS, BOX, title, 0.25, 'files')
    expect(brief(dockShape(d))).toEqual({ row: ['p1[tab:0,tab:1]', 'p2[files]'] })
    const [app, tools] = dockGroups(d.grid.root)
    expect(app!.activeView).toBe('tab:1')
    expect(tools!.activeView).toBe('files')
    const sizes = d.grid.root.type === 'branch' ? d.grid.root.data.map((n) => n.size) : []
    expect(sizes).toEqual([900, 300])
    expect(d.panels['files']).toMatchObject({
      contentComponent: 'tool',
      params: { tab: { kind: 'files' } },
    })
    expect(d.panels['tab:0']).toMatchObject({ contentComponent: 'app', tabComponent: 'app' })
    // Room for the chat, a gap and a tool pane.
    expect(shapeMinWidth(dockShape(d))).toBe(MAIN_MIN + 8 + 240)
  })
})

describe('reconcileDock', () => {
  it('keeps a saved layout that fits, drops what is gone and adds tabs no group shows', () => {
    const saved = defaultDock(TABS, BOX, title)
    expect(reconcileDock(JSON.parse(JSON.stringify(saved)), TABS, title)).toEqual(saved)
    // Tab 0 closed, tab 5 opened elsewhere since: 5 joins the active tab's group.
    const now = createTabs([tab(1, 'chat', { chat: '/s/a.jsonl' }), tab(5, 'jobs')], 0)
    const fixed = reconcileDock(saved, now, title)!
    expect(brief(dockShape(fixed))).toEqual({ row: ['p1[tab:1,tab:5]', 'p2[files]'] })
  })

  it('closes groups left empty and unwraps the split around the last one', () => {
    const saved = defaultDock(TABS, BOX, title) as DockJson
    const tools = dockGroups(saved.grid.root)[1]!
    tools.views = ['nope', 'subagent:/x']
    const fixed = reconcileDock(saved, TABS, title)!
    expect(brief(dockShape(fixed))).toEqual({ row: ['p1[tab:0,tab:1]'] })
    expect(fixed.panels['files']).toBeUndefined()
  })

  it('keeps the maximized group, found again after the tree is fixed', () => {
    const saved = defaultDock(TABS, BOX, title) as DockJson
    const zoomAt = (location: number[], root: unknown = saved.grid.root) =>
      reconcileDock(
        { ...saved, grid: { ...saved.grid, root, maximizedNode: { location } } },
        TABS,
        title,
      )!
    // The app tabs' group maximized (the tool panes hidden).
    expect(zoomAt([0]).grid.maximizedNode).toEqual({ location: [0] })
    // The tools' group saved inside a one-child branch, which normalizing unwraps: the path
    // follows the group.
    const [apps, tools] = saved.grid.root.type === 'branch' ? saved.grid.root.data : []
    const wrapped = zoomAt([0, 0], {
      type: 'branch',
      size: 1,
      data: [{ type: 'branch', size: 1, data: [tools] }, apps],
    })
    expect(brief(dockShape(wrapped))).toEqual({ row: ['p2[files]', 'p1[tab:0,tab:1]'] })
    expect(wrapped.grid.maximizedNode).toEqual({ location: [0] })
    // A path to no group keeps nothing maximized; neither does a layout that saved none.
    expect(zoomAt([5]).grid.maximizedNode).toBeUndefined()
    expect(reconcileDock(saved, TABS, title)!.grid.maximizedNode).toBeUndefined()
  })

  it('refuses what is no layout', () => {
    expect(reconcileDock(null, TABS, title)).toBeNull()
    expect(reconcileDock({ grid: {}, panels: {} }, TABS, title)).toBeNull()
  })
})

describe('migrateTiling', () => {
  const old = {
    version: 1,
    root: {
      type: 'split',
      id: 's1',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { type: 'pane', id: 'chat', tabs: [], active: null },
        {
          type: 'split',
          id: 's4',
          dir: 'column',
          sizes: [0.6, 0.4],
          children: [
            {
              type: 'pane',
              id: 'p2',
              tabs: [{ kind: 'browser' }, { kind: 'files' }],
              active: 'files',
            },
            {
              type: 'pane',
              id: 'p3',
              tabs: [
                { kind: 'page', place: { page: 'test-bench' } },
                { kind: 'page', place: { page: 'review:pr:o/r#2' } },
                { kind: 'page', place: { page: 'chat', chat: '/s/x.jsonl' } },
              ],
              active: 'review:pr:o/r#2',
            },
          ],
        },
      ],
    },
    focus: 'p3',
    zoom: null,
    last_tool: 'p3',
    seq: 5,
  }

  it('turns the chat pane into the app tab group and tool pages into app tabs there', () => {
    const r = migrateTiling(old, TABS, BOX, (_t, id) => id)!
    expect(r.tabs.list.map((t) => [t.id, t.here.page])).toEqual([
      [0, 'dashboard'],
      [1, 'chat'],
      [2, 'test-bench'],
      [3, 'review:pr:o/r#2'],
    ])
    expect(r.tabs.list[r.tabs.active]!.id).toBe(1)
    expect(brief(dockShape(r.dock))).toEqual({
      row: ['p1[tab:0,tab:1]', { column: ['p2[browser,files]', 'p3[tab:2,tab:3]'] }],
    })
    const groups = dockGroups(r.dock.grid.root)
    expect(groups.map((g) => g.activeView)).toEqual(['tab:1', 'files', 'tab:3'])
    expect(r.dock.activeGroup).toBe('p1')
    const root = r.dock.grid.root
    expect(root.type === 'branch' && root.data.map((n) => n.size)).toEqual([600, 600])
    const right = root.type === 'branch' ? root.data[1]! : root
    expect(right.type === 'branch' && right.data.map((n) => n.size)).toEqual([480, 320])
    // It reads back as a layout that fits its tabs.
    expect(reconcileDock(r.dock, r.tabs, title)).toEqual(
      reconcileDock(JSON.parse(JSON.stringify(r.dock)), r.tabs, title),
    )
  })

  it('a tree without the chat pane gets it back on the left; same-way splits merge', () => {
    const r = migrateTiling(
      {
        root: {
          type: 'split',
          id: 's1',
          dir: 'row',
          sizes: [0.5, 0.5],
          children: [
            { type: 'pane', id: 'p7', tabs: [{ kind: 'files' }], active: 'files' },
            {
              type: 'split',
              id: 's2',
              dir: 'row',
              sizes: [0.5, 0.5],
              children: [
                { type: 'pane', id: 'p8', tabs: [{ kind: 'browser' }], active: 'browser' },
                { type: 'pane', id: 'p9', tabs: [{ kind: 'nope' }], active: null },
              ],
            },
          ],
        },
      },
      TABS,
      BOX,
      (_t, id) => id,
    )!
    expect(brief(dockShape(r.dock))).toEqual({
      row: ['p1[tab:0,tab:1]', 'p7[files]', 'p8[browser]'],
    })
    expect(migrateTiling(null, TABS, BOX, (_t, id) => id)).toBeNull()
    expect(migrateTiling({ root: { type: 'nope' } }, TABS, BOX, (_t, id) => id)).toBeNull()
  })
})

describe('neighbor', () => {
  it('finds the pane beside, by most overlap among the nearest', () => {
    const rects = {
      a: { x: 0, y: 0, w: 100, h: 200 },
      b: { x: 108, y: 0, w: 100, h: 90 },
      c: { x: 108, y: 98, w: 100, h: 102 },
    }
    expect(neighbor(rects, 'a', 'right')).toBe('c')
    expect(neighbor(rects, 'b', 'down')).toBe('c')
    expect(neighbor(rects, 'b', 'left')).toBe('a')
    expect(neighbor(rects, 'a', 'left')).toBeNull()
  })
})
