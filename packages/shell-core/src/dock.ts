/**
 * The window's panes as Relay models them on dockview (the renderer's tiling/dock wraps the
 * engine): every tab is a dockview panel, every pane a dockview group. An app tab (a chat or a
 * page, kept with its history by the tabs store) is the panel `tab:<id>`; a tool tab (Browser,
 * Files, a subagent's transcript, an experiment arm) is the panel named by its tool tab id. Any
 * group takes any tab.
 *
 * Pure data only: panel ids, tool tabs, the saved layout (dockview's own toJSON shape, under
 * layout.json `dock`), the default layout, reconciling a saved layout with the tabs it names, and
 * the one-time migration from the split tree layout.json kept before dockview (`tiling`).
 */
import { GAP, MAIN_MIN } from './fit'
import { placeFromJson, placeKey, type Place } from './place'
import { createTabs, type Tab, type Tabs } from './tabs'

/** The default tool pane's share of the panes' width. */
export const TOOL_PANE_SHARE = 0.34
/** Smallest pane a sash drag leaves (px); a pane holding app tabs keeps MAIN_MIN wide. */
export const TILE_MIN_W = 240
export const TILE_MIN_H = 140

export type Side = 'left' | 'right' | 'up' | 'down'

// Tool tabs ------------------------------------------------------------------------------------

export type ToolKind = 'browser' | 'files' | 'terminal'
/** The tools a fresh layout opens; Terminal is added from a pane's + menu. */
export const TOOL_KINDS: readonly ToolKind[] = ['browser', 'files']
export const isToolKind = (v: unknown): v is ToolKind =>
  v === 'browser' || v === 'files' || v === 'terminal'

export type ToolTab =
  | { kind: ToolKind }
  | {
      kind: 'subagent'
      /** The chat session file the subagent belongs to. */
      session: string
      /** Absolute path of the subagent `.jsonl` transcript. */
      file: string
      name: string
    }
  | {
      kind: 'experiment-arm'
      /** Folder name under work/experiments. */
      experiment: string
      arm: string
      label: string
    }
export type SubagentTab = Extract<ToolTab, { kind: 'subagent' }>
export type ExperimentArmTab = Extract<ToolTab, { kind: 'experiment-arm' }>

/** A tool tab's panel id: what it shows, so one thing is open once. */
export function toolTabId(tab: ToolTab): string {
  switch (tab.kind) {
    case 'subagent':
      return `subagent:${tab.file}`
    case 'experiment-arm':
      return `arm:${tab.experiment}/${tab.arm}`
    default:
      return tab.kind
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096

/** One saved tool tab, or null when it is not one this build knows. */
export function toolTabFromJson(v: unknown): ToolTab | null {
  if (!isObject(v)) return null
  const kind = v['kind']
  if (isToolKind(kind)) return { kind }
  if (kind === 'subagent' && str(v['session']) && str(v['file']) && str(v['name'])) {
    return { kind, session: v['session'], file: v['file'], name: v['name'] }
  }
  if (kind === 'experiment-arm' && str(v['experiment']) && str(v['arm']) && str(v['label'])) {
    return { kind, experiment: v['experiment'], arm: v['arm'], label: v['label'] }
  }
  return null
}

// Panels ---------------------------------------------------------------------------------------

/** Dockview component names: an app tab's content and tab, a tool tab's. */
export const APP_PANEL = 'app'
export const TOOL_PANEL = 'tool'

export const appPanelId = (tab: number): string => `tab:${tab}`

/** The app tab a panel shows, or null for a tool panel. */
export function appTabOf(panelId: string): number | null {
  const m = /^tab:(\d+)$/.exec(panelId)
  return m ? Number(m[1]) : null
}

// The saved layout: dockview's SerializedDockview, kept to what Relay writes and reads ----------

export type DockOrientation = 'HORIZONTAL' | 'VERTICAL'

export interface DockGroupJson {
  id: string
  /** Panel ids in tab order. */
  views: string[]
  activeView?: string
  [key: string]: unknown
}

export interface DockLeaf {
  type: 'leaf'
  data: DockGroupJson
  /** Px along the parent branch. */
  size: number
  visible?: boolean
}

export interface DockBranch {
  type: 'branch'
  data: DockNode[]
  size: number
  visible?: boolean
}

export type DockNode = DockLeaf | DockBranch

export interface DockPanelJson {
  id: string
  contentComponent?: string
  tabComponent?: string
  title?: string
  params?: Record<string, unknown>
  [key: string]: unknown
}

export interface DockJson {
  grid: {
    root: DockNode
    width: number
    height: number
    orientation: DockOrientation
    /** The maximized group's path of child indices (the tool panes hidden). */
    maximizedNode?: { location: number[] }
  }
  panels: Record<string, DockPanelJson>
  activeGroup?: string
  [key: string]: unknown
}

export const orthogonal = (o: DockOrientation): DockOrientation =>
  o === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL'

export function appPanelJson(tab: number, title: string): DockPanelJson {
  return {
    id: appPanelId(tab),
    contentComponent: APP_PANEL,
    tabComponent: APP_PANEL,
    title,
    params: {},
  }
}

export function toolPanelJson(tab: ToolTab, title: string): DockPanelJson {
  return {
    id: toolTabId(tab),
    contentComponent: TOOL_PANEL,
    tabComponent: TOOL_PANEL,
    title,
    params: { tab },
  }
}

/** The tool tab a saved tool panel shows. */
export function toolTabOfPanel(panel: DockPanelJson | undefined): ToolTab | null {
  if (!panel || panel.contentComponent !== TOOL_PANEL) return null
  const tab = toolTabFromJson(panel.params?.['tab'])
  return tab && toolTabId(tab) === panel.id ? tab : null
}

/** Every group in the grid, left to right and top to bottom. */
export function dockGroups(node: DockNode): DockGroupJson[] {
  return node.type === 'leaf' ? [node.data] : node.data.flatMap(dockGroups)
}

/** The path of child indices to group `id` (dockview's grid location), or null. */
function locateGroup(node: DockNode, id: string): number[] | null {
  if (node.type === 'leaf') return node.data.id === id ? [] : null
  for (const [i, child] of node.data.entries()) {
    const rest = locateGroup(child, id)
    if (rest) return [i, ...rest]
  }
  return null
}

/**
 * The tree as Relay reads it: a group is a pane; a branch is a `row` (side by side) or `column`
 * (stacked), following dockview's alternating orientations from the root's.
 */
export type DockShape =
  | { type: 'pane'; id: string; views: string[]; active: string | null; size: number }
  | { type: 'split'; dir: 'row' | 'column'; size: number; children: DockShape[] }

export function dockShape(json: DockJson): DockShape {
  const walk = (node: DockNode, o: DockOrientation): DockShape =>
    node.type === 'leaf'
      ? {
          type: 'pane',
          id: node.data.id,
          views: [...node.data.views],
          active: node.data.activeView ?? node.data.views[0] ?? null,
          size: node.size,
        }
      : {
          type: 'split',
          dir: o === 'HORIZONTAL' ? 'row' : 'column',
          size: node.size,
          children: node.data.map((c) => walk(c, orthogonal(o))),
        }
  return walk(json.grid.root, json.grid.orientation)
}

/** A pane holding an app tab keeps room for a chat; a tool pane less. */
export function paneMinWidth(views: readonly string[]): number {
  return views.some((v) => appTabOf(v) !== null) ? MAIN_MIN : TILE_MIN_W
}

/** The smallest width the shape takes, gaps included (the sidebar folds to make room). */
export function shapeMinWidth(shape: DockShape, gap = GAP): number {
  if (shape.type === 'pane') return paneMinWidth(shape.views)
  const mins = shape.children.map((c) => shapeMinWidth(c, gap))
  if (shape.dir === 'column') return Math.max(0, ...mins)
  return mins.reduce((a, b) => a + b, 0) + gap * (mins.length - 1)
}

// Building and repairing a layout ----------------------------------------------------------------

export interface Box {
  width: number
  height: number
}

const leaf = (data: DockGroupJson, size: number): DockLeaf => ({ type: 'leaf', data, size })

/**
 * Drops empty groups, unwraps one-child branches (a branch's only branch child hands its children
 * up, keeping orientations alternating) and rescales sizes so siblings fill their parent.
 * Returns the new root with its orientation, or null when no group is left.
 */
export function normalizeDock(
  root: DockNode,
  orientation: DockOrientation,
): { root: DockNode; orientation: DockOrientation } | null {
  const clean = (node: DockNode): DockNode | null => {
    if (node.type === 'leaf') return node.data.views.length > 0 ? node : null
    const kept: DockNode[] = []
    for (const c of node.data) {
      const n = clean(c)
      if (!n) continue
      // A one-child branch below: its child runs our way, so it takes its place among ours.
      if (n.type === 'branch' && n.data.length === 1 && n.data[0]!.type === 'branch') {
        const grand = n.data[0]!
        const total = grand.data.reduce((a, g) => a + g.size, 0) || 1
        for (const g of grand.data) kept.push({ ...g, size: (n.size * g.size) / total })
        continue
      }
      if (n.type === 'branch' && n.data.length === 1) {
        kept.push({ ...n.data[0]!, size: n.size })
        continue
      }
      kept.push(n)
    }
    if (kept.length === 0) return null
    const before = node.data.reduce((a, c) => a + (Number.isFinite(c.size) ? c.size : 0), 0)
    const after = kept.reduce((a, c) => a + (Number.isFinite(c.size) && c.size > 0 ? c.size : 0), 0)
    const scale = after > 0 && before > 0 ? before / after : 1
    const sized = kept.map((c) => ({
      ...c,
      size: Number.isFinite(c.size) && c.size > 0 ? c.size * scale : before / kept.length || 1,
    }))
    return { ...node, data: sized }
  }
  let next = clean(root)
  let o = orientation
  if (!next) return null
  // The root keeps one branch at least; a lone branch child becomes the root, turned its way.
  while (next.type === 'branch' && next.data.length === 1 && next.data[0]!.type === 'branch') {
    next = { ...next.data[0]!, size: next.size }
    o = orthogonal(o)
  }
  if (next.type === 'leaf') next = { type: 'branch', data: [next], size: next.size }
  return { root: next, orientation: o }
}

/**
 * Today's shell for a fresh config: the app tabs on the left and one tool pane on the right with
 * Browser and Files, `tool` in front, taking `share` of the width.
 */
export function defaultDock(
  tabs: Tabs,
  box: Box,
  titles: (id: string) => string,
  share = TOOL_PANE_SHARE,
  tool: ToolKind = 'browser',
): DockJson {
  const s = Number.isFinite(share) ? Math.min(Math.max(share, 0.05), 0.95) : TOOL_PANE_SHARE
  const app = appGroup('p1', tabs)
  const tools: DockGroupJson = { id: 'p2', views: [...TOOL_KINDS], activeView: tool }
  const panels: Record<string, DockPanelJson> = {}
  for (const t of tabs.list) panels[appPanelId(t.id)] = appPanelJson(t.id, titles(appPanelId(t.id)))
  for (const kind of TOOL_KINDS) panels[kind] = toolPanelJson({ kind }, titles(kind))
  const w = Math.max(box.width, 1)
  return {
    grid: {
      root: {
        type: 'branch',
        data: [leaf(app, Math.round(w * (1 - s))), leaf(tools, Math.round(w * s))],
        size: box.height,
      },
      width: box.width,
      height: box.height,
      orientation: 'HORIZONTAL',
    },
    panels,
    activeGroup: 'p1',
  }
}

function appGroup(id: string, tabs: Tabs): DockGroupJson {
  const active = tabs.list[tabs.active]
  return {
    id,
    views: tabs.list.map((t) => appPanelId(t.id)),
    ...(active ? { activeView: appPanelId(active.id) } : {}),
  }
}

/**
 * A saved layout made to fit the tabs: panels for app tabs that are gone, unknown tool tabs and
 * duplicates drop out, empty groups close, and app tabs no group shows join the group holding
 * the active app tab (else the first group). null when nothing usable is left.
 */
export function reconcileDock(
  saved: unknown,
  tabs: Tabs,
  titles: (id: string) => string,
): DockJson | null {
  if (!isObject(saved) || !isObject(saved['grid']) || !isObject(saved['panels'])) return null
  const grid = saved['grid']
  const rawPanels = saved['panels'] as Record<string, unknown>
  const orientation: DockOrientation =
    grid['orientation'] === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL'
  const width = typeof grid['width'] === 'number' && grid['width'] > 0 ? grid['width'] : 1000
  const height = typeof grid['height'] === 'number' && grid['height'] > 0 ? grid['height'] : 700
  const appIds = new Set(tabs.list.map((t) => appPanelId(t.id)))
  const panels: Record<string, DockPanelJson> = {}
  const seenGroups = new Set<string>()
  const seenViews = new Set<string>()
  let nodes = 0

  const keepView = (id: unknown): id is string => {
    if (typeof id !== 'string' || seenViews.has(id)) return false
    if (appIds.has(id)) {
      panels[id] = appPanelJson(appTabOf(id)!, titles(id))
      seenViews.add(id)
      return true
    }
    const raw = rawPanels[id]
    const tab = isObject(raw) ? toolTabOfPanel(raw as DockPanelJson) : null
    if (!tab) return false
    panels[id] = toolPanelJson(tab, titles(id))
    seenViews.add(id)
    return true
  }

  const read = (raw: unknown, depth: number): DockNode | null => {
    if (!isObject(raw) || depth > 12 || ++nodes > 128) return null
    const size = typeof raw['size'] === 'number' && raw['size'] > 0 ? raw['size'] : 1
    if (raw['type'] === 'leaf') {
      const data = raw['data']
      if (!isObject(data) || !str(data['id']) || seenGroups.has(data['id'])) return null
      seenGroups.add(data['id'])
      const views = (Array.isArray(data['views']) ? data['views'] : []).filter(keepView)
      const active = typeof data['activeView'] === 'string' ? data['activeView'] : undefined
      const group: DockGroupJson = { id: data['id'], views }
      const front = active !== undefined && views.includes(active) ? active : views[0]
      if (front !== undefined) group.activeView = front
      return leaf(group, size)
    }
    if (raw['type'] === 'branch' && Array.isArray(raw['data'])) {
      const data = raw['data'].map((c) => read(c, depth + 1)).filter((c) => c !== null)
      return { type: 'branch', data, size }
    }
    return null
  }

  const rootRaw = read(grid['root'], 0)
  if (!rootRaw) return null
  // The maximized group, by id: the location is of the saved tree, which normalizing may change.
  let zoomed: unknown = grid['root']
  const zoomAt = isObject(grid['maximizedNode']) ? grid['maximizedNode']['location'] : null
  for (const i of Array.isArray(zoomAt) ? zoomAt : [null]) {
    zoomed =
      isObject(zoomed) && Array.isArray(zoomed['data']) && typeof i === 'number'
        ? zoomed['data'][i]
        : null
  }
  const zoomId = isObject(zoomed) && isObject(zoomed['data']) ? zoomed['data']['id'] : null
  const fixed = normalizeDock(rootRaw, orientation)
  if (!fixed) return null
  const location = typeof zoomId === 'string' ? locateGroup(fixed.root, zoomId) : null
  // App tabs no group shows join the active one's group, else the first group.
  const groups = dockGroups(fixed.root)
  const missing = tabs.list.map((t) => appPanelId(t.id)).filter((id) => !seenViews.has(id))
  if (missing.length) {
    const active = tabs.list[tabs.active]
    const home =
      groups.find((g) => active && g.views.includes(appPanelId(active.id))) ??
      groups.find((g) => g.views.some((v) => appIds.has(v))) ??
      groups[0]!
    for (const id of missing) {
      home.views.push(id)
      panels[id] = appPanelJson(appTabOf(id)!, titles(id))
    }
    home.activeView ??= home.views[0]
  }
  const activeGroup =
    typeof saved['activeGroup'] === 'string' && groups.some((g) => g.id === saved['activeGroup'])
      ? saved['activeGroup']
      : groups[0]?.id
  return {
    grid: {
      root: fixed.root,
      width,
      height,
      orientation: fixed.orientation,
      ...(location && location.length > 0 ? { maximizedNode: { location } } : {}),
    },
    panels,
    ...(activeGroup ? { activeGroup } : {}),
  }
}

// Migration from the split tree (layout.json `tiling`, version 1) ------------------------------

/** The old tree, read: panes become groups, splits keep their direction and shares. */
type OldNode =
  | { type: 'group'; group: DockGroupJson }
  | { type: 'split'; dir: 'row' | 'column'; children: OldNode[]; shares: number[] }

/**
 * The pre-dockview `tiling` as a dockview layout, once: the chat pane becomes the group holding
 * every app tab, each tool pane a group with its tabs, splits keep their shares. A page that sat
 * in a tool pane (`{kind: 'page'}`) becomes an app tab of that group (added to `tabs`), since any
 * group shows pages now. null when the saved value is no tree this reads.
 */
export function migrateTiling(
  saved: unknown,
  tabs: Tabs,
  box: Box,
  titles: (tabs: Tabs, id: string) => string,
): { dock: DockJson; tabs: Tabs } | null {
  if (!isObject(saved) || !isObject(saved['root'])) return null
  const list: Tab[] = [...tabs.list]
  let nextId = tabs.nextId
  const tools = new Map<string, ToolTab>()
  const byPlace = new Map<string, number>()
  for (const t of list) byPlace.set(placeKey(t.here), t.id)
  const usedIds = new Set<string>()
  const chat: DockGroupJson = { id: '', views: [] }
  let chatSeen = false
  let count = 0

  const read = (raw: unknown, depth: number): OldNode | null => {
    if (!isObject(raw) || depth > 12 || ++count > 64) return null
    if (raw['type'] === 'pane') {
      if (raw['id'] === 'chat') {
        if (chatSeen) return null
        chatSeen = true
        return { type: 'group', group: chat }
      }
      const views: string[] = []
      for (const x of Array.isArray(raw['tabs']) ? raw['tabs'] : []) {
        const tool = toolTabFromJson(x)
        if (tool) {
          const id = toolTabId(tool)
          if (tools.has(id)) continue
          tools.set(id, tool)
          views.push(id)
          continue
        }
        const place: Place | null =
          isObject(x) && x['kind'] === 'page' ? placeFromJson(x['place']) : null
        if (!place || place.page === 'chat' || byPlace.has(placeKey(place))) continue
        const tab: Tab = { id: nextId++, here: place, back: [], forward: [], pinned: false }
        list.push(tab)
        byPlace.set(placeKey(place), tab.id)
        views.push(appPanelId(tab.id))
      }
      if (views.length === 0) return null
      // The old front tab id: a tool tab id, or a page's place key.
      const old = typeof raw['active'] === 'string' ? raw['active'] : ''
      const page = byPlace.get(old)
      const activeView = views.includes(old)
        ? old
        : page !== undefined && views.includes(appPanelId(page))
          ? appPanelId(page)
          : views[0]!
      const named = typeof raw['id'] === 'string' && /^p\d+$/.test(raw['id']) ? raw['id'] : ''
      const id = named && !usedIds.has(named) ? named : ''
      if (id) usedIds.add(id)
      return { type: 'group', group: { id, views, activeView } }
    }
    if (raw['type'] !== 'split' || (raw['dir'] !== 'row' && raw['dir'] !== 'column')) return null
    const dir = raw['dir']
    const rawKids = Array.isArray(raw['children']) ? raw['children'] : []
    const rawShares = Array.isArray(raw['sizes']) ? raw['sizes'] : []
    const children: OldNode[] = []
    const shares: number[] = []
    rawKids.forEach((c, i) => {
      const n = read(c, depth + 1)
      const s = rawShares[i]
      const share = typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1 / rawKids.length
      if (!n) return
      // A same-way split inside joins this one: dockview alternates directions.
      if (n.type === 'split' && n.dir === dir) {
        const total = n.shares.reduce((a, b) => a + b, 0) || 1
        n.children.forEach((g, j) => {
          children.push(g)
          shares.push((share * (n.shares[j] ?? 0)) / total)
        })
        return
      }
      children.push(n)
      shares.push(share)
    })
    if (children.length === 0) return null
    if (children.length === 1) return children[0]!
    return { type: 'split', dir, children, shares }
  }

  let root = read(saved['root'], 0)
  if (!root) return null
  if (!chatSeen) {
    // No chat pane saved: the app tabs come back on the left.
    const group: OldNode = { type: 'group', group: chat }
    root =
      root.type === 'split' && root.dir === 'row'
        ? {
            ...root,
            children: [group, ...root.children],
            shares: [1 - TOOL_PANE_SHARE, ...root.shares.map((s) => s * TOOL_PANE_SHARE)],
          }
        : {
            type: 'split',
            dir: 'row',
            children: [group, root],
            shares: [1 - TOOL_PANE_SHARE, TOOL_PANE_SHARE],
          }
  }
  const migrated = { ...createTabs(list, tabs.active, nextId), fresh: false }
  // The chat pane holds every app tab but the pages that came out of tool panes.
  const own = migrated.list.filter((t) => t.id < tabs.nextId)
  const front = migrated.list[migrated.active]
  chat.views = own.map((t) => appPanelId(t.id))
  if (front && front.id < tabs.nextId) chat.activeView = appPanelId(front.id)
  else if (chat.views[0]) chat.activeView = chat.views[0]
  // Tool panes keep their ids; the chat pane and any unnamed pane take a free p<n>.
  const toDock = (node: OldNode, size: number, along: number, across: number): DockNode => {
    if (node.type === 'group') {
      if (!node.group.id) {
        let n = 1
        while (usedIds.has(`p${n}`)) n++
        node.group.id = `p${n}`
        usedIds.add(node.group.id)
      }
      return leaf(node.group, size)
    }
    const total = node.shares.reduce((a, b) => a + b, 0) || 1
    return {
      type: 'branch',
      size,
      data: node.children.map((c, i) =>
        toDock(c, Math.max(1, Math.round((along * (node.shares[i] ?? 0)) / total)), across, along),
      ),
    }
  }
  const orientation: DockOrientation =
    root.type === 'split' && root.dir === 'column' ? 'VERTICAL' : 'HORIZONTAL'
  const [along, across] =
    orientation === 'HORIZONTAL' ? [box.width, box.height] : [box.height, box.width]
  const fixed = normalizeDock(toDock(root, across, along, across), orientation)
  if (!fixed) return null
  const panels: Record<string, DockPanelJson> = {}
  for (const t of migrated.list) {
    panels[appPanelId(t.id)] = appPanelJson(t.id, titles(migrated, appPanelId(t.id)))
  }
  for (const [id, tool] of tools) panels[id] = toolPanelJson(tool, titles(migrated, id))
  const groups = dockGroups(fixed.root)
  return {
    dock: {
      grid: {
        root: fixed.root,
        width: box.width,
        height: box.height,
        orientation: fixed.orientation,
      },
      panels,
      activeGroup: chat.views.length ? chat.id : groups[0]!.id,
    },
    tabs: migrated,
  }
}

// Geometry -------------------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Each pane's rect from the saved sizes alone (no DOM): branches lay their children out along
 * their orientation, from the grid's own width and height. Gaps are not counted.
 */
export function dockRects(json: DockJson): Record<string, Rect> {
  const out: Record<string, Rect> = {}
  const walk = (node: DockNode, o: DockOrientation, r: Rect): void => {
    if (node.type === 'leaf') {
      out[node.data.id] = r
      return
    }
    let at = o === 'HORIZONTAL' ? r.x : r.y
    for (const c of node.data) {
      const box: Rect =
        o === 'HORIZONTAL'
          ? { x: at, y: r.y, w: c.size, h: r.h }
          : { x: r.x, y: at, w: r.w, h: c.size }
      walk(c, orthogonal(o), box)
      at += c.size
    }
  }
  const { root, width, height, orientation } = json.grid
  walk(root, orientation, { x: 0, y: 0, w: width, h: height })
  return out
}

/** The pane next to `from` toward `side` (most overlap among the nearest), if any. */
export function neighbor(rects: Record<string, Rect>, from: string, side: Side): string | null {
  const a = rects[from]
  if (!a) return null
  let best: { id: string; dist: number; overlap: number } | null = null
  for (const [id, b] of Object.entries(rects)) {
    if (id === from) continue
    const horizontal = side === 'left' || side === 'right'
    const dist =
      side === 'right'
        ? b.x - (a.x + a.w)
        : side === 'left'
          ? a.x - (b.x + b.w)
          : side === 'down'
            ? b.y - (a.y + a.h)
            : a.y - (b.y + b.h)
    if (dist < -1) continue
    const overlap = horizontal
      ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    if (overlap <= 0) continue
    if (
      !best ||
      dist < best.dist - 1 ||
      (Math.abs(dist - best.dist) <= 1 && overlap > best.overlap)
    ) {
      best = { id, dist, overlap }
    }
  }
  return best?.id ?? null
}
