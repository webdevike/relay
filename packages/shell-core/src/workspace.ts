/**
 * Workspaces: the window shows one at a time, each with its own panes (Isaac, 2026-11-05). A
 * workspace is an assistant (its thread and every session it owns, with all their tools), a plain
 * chat, or a page. Its key is also its browser scope, so a workspace's web pages stay its own.
 *
 * Pure data only: the key of a place, the app tabs a workspace shows, a saved layout made to fit
 * them (pinned tabs added, other workspaces' tabs dropped), what a workspace keeps of a layout
 * (pinned tabs are global, saved apart), navigation that never moves a tab between workspaces,
 * the layout.json `workspaces` record, and the one-time move from the single window layout.
 */
import {
  TOOL_PANE_SHARE,
  appPanelId,
  appPanelJson,
  appTabOf,
  dockGroups,
  locateGroup,
  normalizeDock,
  pageTab,
  reconcileDock,
  toolPanelJson,
  toolTabFromJson,
  toolTabId,
  type Box,
  type DockGroupJson,
  type DockJson,
  type DockNode,
  type DockPanelJson,
  type ToolTab,
} from './dock'
import { pageFromKey, placeOf, samePlace, type Place } from './place'
import { navigate, switchTo, type Tab, type Tabs } from './tabs'

const ASSISTANT = 'page:agent:'

/** Who owns a chat session: the assistant id at the end of its owner chain, else null. */
export type OwnerOf = (file: string) => string | null

/**
 * The workspace `place` belongs to, as shown by app tab `tabId`: `page:agent:<id>` for an
 * assistant's thread and the sessions it owns, `chat:<file>` for a plain chat (`draft:<tab>` until
 * it has a file), else the page's own (`page:<page>`; every board, meeting, settings section and
 * Reviews item shares its page's).
 */
export function workspaceOf(place: Place, tabId: number, ownerOf: OwnerOf): string {
  switch (place.page) {
    case 'chat': {
      if (place.chat === null || place.chat === 'draft') return `draft:${tabId}`
      const owner = ownerOf(place.chat)
      return owner === null ? `chat:${place.chat}` : `${ASSISTANT}${owner}`
    }
    default:
      if (place.page.startsWith('review:')) return 'page:reviews'
      return `page:${place.page}`
  }
}

export const isAssistantWorkspace = (ws: string): boolean =>
  ws.startsWith(ASSISTANT) && ws.length > ASSISTANT.length

/** The assistant id of an assistant's workspace, else null. */
export function workspaceAgent(ws: string): string | null {
  return isAssistantWorkspace(ws) ? ws.slice(ASSISTANT.length) : null
}

/** What a workspace shows when Isaac opens it with no tab of its own: its thread, chat or page. */
export function workspaceHome(ws: string): Place | null {
  if (ws.startsWith('chat:') && ws.length > 'chat:'.length) {
    return placeOf('chat', { chat: ws.slice('chat:'.length) })
  }
  if (ws.startsWith('draft:')) return placeOf('chat')
  if (!ws.startsWith('page:')) return null
  const page = pageFromKey(ws.slice('page:'.length))
  return page === null || page === 'chat' ? null : placeOf(page)
}

/**
 * The app tabs workspace `ws` shows: its own, and those every workspace shows (`everywhere`: the
 * pinned ones by default; the app adds unsent drafts, so they stay reachable).
 */
export function workspaceTabs(
  tabs: Tabs,
  ws: string,
  wsOf: (t: Tab) => string,
  everywhere: (t: Tab) => boolean = (t) => t.pinned,
): Tab[] {
  return tabs.list.filter((t) => everywhere(t) || wsOf(t) === ws)
}

/** `tabs` cut to `list`, the active tab kept when it is there (else the first unpinned one). */
function subset(tabs: Tabs, list: Tab[]): Tabs {
  const active = tabs.list[tabs.active]
  let ix = active ? list.findIndex((t) => t.id === active.id) : -1
  if (ix < 0)
    ix = Math.max(
      0,
      list.findIndex((t) => !t.pinned),
    )
  return { ...tabs, list, active: ix }
}

const leaf = (data: DockGroupJson, size: number): DockNode => ({ type: 'leaf', data, size })

function freshGroupId(json: DockJson): string {
  let n = 0
  for (const g of dockGroups(json.grid.root)) {
    const m = /^p(\d+)$/.exec(g.id)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return `p${n + 1}`
}

/** Puts a new group on the right edge, taking `share` of the width. */
function addRight(json: DockJson, group: DockGroupJson, share: number): void {
  const { grid } = json
  const width = Math.max(grid.width, 1)
  const take = Math.round(width * share)
  if (grid.orientation === 'HORIZONTAL' && grid.root.type === 'branch') {
    const total = grid.root.data.reduce((a, c) => a + c.size, 0) || 1
    const scale = (width - take) / total
    grid.root = {
      ...grid.root,
      data: [...grid.root.data.map((c) => ({ ...c, size: c.size * scale })), leaf(group, take)],
    }
    return
  }
  // A column at the root: it becomes the left side of a new row.
  grid.root = {
    type: 'branch',
    size: grid.height,
    data: [{ ...grid.root, size: width - take }, leaf(group, take)],
  }
  grid.orientation = 'HORIZONTAL'
  if (grid.maximizedNode) grid.maximizedNode = { location: [0, ...grid.maximizedNode.location] }
}

/** The group at a grid location (dockview's maximizedNode), or null. */
function groupAt(root: DockNode, location: readonly number[]): string | null {
  let node: DockNode | undefined = root
  for (const i of location) node = node?.type === 'branch' ? node.data[i] : undefined
  return node?.type === 'leaf' ? node.data.id : null
}

export interface ComposeOptions {
  /** Every app tab; the workspace's own and the pinned ones are kept (wsOf decides). */
  tabs: Tabs
  ws: string
  wsOf: (t: Tab) => string
  /** App tabs every workspace shows; the pinned ones when not given. */
  everywhere?: (t: Tab) => boolean
  /** Tool tabs pinned to every workspace. */
  pinned: readonly ToolTab[]
  box: Box
  titles: (id: string) => string
}

/** `saved` with HOME_VIEW standing in for the workspace's tabs it does not show yet. */
function withHome(saved: unknown, mine: readonly string[]): unknown {
  if (!isDock(saved)) return saved
  const present = new Set(dockGroups(saved.grid.root).flatMap((g) => g.views))
  const missing = mine.filter((id) => !present.has(id))
  let used = false
  const walk = (node: DockNode): DockNode => {
    if (node.type === 'branch') return { ...node, data: node.data.map(walk) }
    if (!node.data.views.includes(HOME_VIEW)) return node
    const views = node.data.views.flatMap((v) => {
      if (v !== HOME_VIEW) return [v]
      if (used) return []
      used = true
      return missing
    })
    const activeView = node.data.activeView === HOME_VIEW ? missing[0] : node.data.activeView
    const data: DockGroupJson = { ...node.data, views }
    if (activeView === undefined) delete data.activeView
    else data.activeView = activeView
    return { ...node, data }
  }
  return { ...saved, grid: { ...saved.grid, root: walk(saved.grid.root) } }
}

/**
 * Workspace `ws`'s panes from its saved layout (or none yet): other workspaces' app tabs drop out,
 * its own and the pinned ones join the pane holding its active tab, and pinned tool tabs it lacks
 * join its first tool pane (else a new pane on the right). null when it has no app tab to show.
 */
export function composeWorkspace(saved: unknown, o: ComposeOptions): DockJson | null {
  const list = workspaceTabs(o.tabs, o.ws, o.wsOf, o.everywhere)
  if (list.length === 0) return null
  const tabs = subset(o.tabs, list)
  const mine = list.filter((t) => o.wsOf(t) === o.ws).map((t) => appPanelId(t.id))
  const home = withHome(saved, mine)
  let json = home === null || home === undefined ? null : reconcileDock(home, tabs, o.titles)
  if (!json) {
    const active = tabs.list[tabs.active]
    const panels: Record<string, DockPanelJson> = {}
    for (const t of tabs.list)
      panels[appPanelId(t.id)] = appPanelJson(t.id, o.titles(appPanelId(t.id)))
    json = {
      grid: {
        root: {
          type: 'branch',
          size: o.box.height,
          data: [
            leaf(
              {
                id: 'p1',
                views: tabs.list.map((t) => appPanelId(t.id)),
                ...(active ? { activeView: appPanelId(active.id) } : {}),
              },
              o.box.width,
            ),
          ],
        },
        width: o.box.width,
        height: o.box.height,
        orientation: 'HORIZONTAL',
      },
      panels,
      activeGroup: 'p1',
    }
  }
  const missing = o.pinned.filter((t) => !json.panels[toolTabId(t)])
  if (missing.length > 0) {
    let home = dockGroups(json.grid.root).find((g) => !g.views.some((v) => appTabOf(v) !== null))
    if (!home) {
      home = { id: freshGroupId(json), views: [] }
      addRight(json, home, TOOL_PANE_SHARE)
    }
    const lead = home.views.filter((v) => o.pinned.some((t) => toolTabId(t) === v)).length
    home.views.splice(lead, 0, ...missing.map(toolTabId))
    home.activeView ??= home.views[0]
    for (const t of missing) json.panels[toolTabId(t)] = toolPanelJson(t, o.titles(toolTabId(t)))
  }
  // Other workspaces' tabs shown here (shortcuts) join the first pane of app tabs, wherever the
  // active tab is; pinned app tabs lead their strip, in the tab bar's order.
  const groups = dockGroups(json.grid.root)
  const lead = groups.find((g) => g.views.some((v) => appTabOf(v) !== null))
  for (const t of list) {
    const id = appPanelId(t.id)
    const at = groups.find((g) => g.views.includes(id))
    if (!lead || !at || at === lead || o.wsOf(t) === o.ws) continue
    at.views = at.views.filter((v) => v !== id)
    if (at.activeView === id) at.activeView = at.views[0]
    lead.views.push(id)
  }
  const pinnedApps = list.filter((t) => t.pinned).map((t) => appPanelId(t.id))
  for (const g of groups) {
    const first = pinnedApps.filter((v) => g.views.includes(v))
    if (first.length) g.views = [...first, ...g.views.filter((v) => !first.includes(v))]
  }
  return json
}

/**
 * Where a workspace's chat stood when its tab went on to another workspace (routeTo `reuse`):
 * kept in its saved layout so the tab it gets on return lands in the same pane.
 */
export const HOME_VIEW = 'tab:home'

/**
 * What workspace `ws` keeps of its live layout: pinned tabs (app or tool) are everyone's, so they
 * leave it; groups they emptied close. A tab that went on to another workspace (`away`) leaves
 * HOME_VIEW in its place. null when nothing of its own is left.
 */
export function ownLayout(
  json: DockJson,
  isGlobal: (panelId: string) => boolean,
  away: (panelId: string) => boolean = () => false,
): DockJson | null {
  const strip = (node: DockNode): DockNode => {
    if (node.type === 'branch') return { ...node, data: node.data.map(strip) }
    const homed = node.data.views.map((v) => (away(v) ? HOME_VIEW : v))
    const views = homed
      .filter((v) => !isGlobal(v))
      .filter((v, i, all) => v !== HOME_VIEW || all.indexOf(v) === i)
    const data: DockGroupJson = { ...node.data, views }
    const front =
      data.activeView !== undefined && away(data.activeView) ? HOME_VIEW : data.activeView
    if (front !== undefined && views.includes(front)) data.activeView = front
    else if (views[0] === undefined) delete data.activeView
    else data.activeView = views[0]
    return { ...node, data }
  }
  const fixed = normalizeDock(strip(json.grid.root), json.grid.orientation)
  if (!fixed) return null
  const panels: Record<string, DockPanelJson> = {}
  for (const g of dockGroups(fixed.root)) {
    for (const v of g.views) {
      const p = json.panels[v]
      if (p) panels[v] = p
    }
  }
  const groups = dockGroups(fixed.root)
  const { maximizedNode, ...grid } = json.grid
  const zoomed = maximizedNode ? groupAt(json.grid.root, maximizedNode.location) : null
  const location = zoomed ? locateGroup(fixed.root, zoomed) : null
  return {
    ...json,
    grid: {
      ...grid,
      root: fixed.root,
      orientation: fixed.orientation,
      ...(location && location.length > 0 ? { maximizedNode: { location } } : {}),
    },
    panels,
    ...(groups.some((g) => g.id === json.activeGroup) ? {} : { activeGroup: groups[0]?.id }),
  }
}

/** A layout holds nothing but app tabs: no tool tab, one pane. Not worth keeping. */
export function isBareLayout(json: DockJson): boolean {
  const groups = dockGroups(json.grid.root)
  const app = (v: string): boolean => v === HOME_VIEW || appTabOf(v) !== null
  return groups.length <= 1 && groups.every((g) => g.views.every(app))
}

// Navigation -------------------------------------------------------------------------------------

export interface RouteOptions {
  wsOf: (t: Tab) => string
  /** The workspace on screen. */
  front: string
  newTab?: boolean
  /**
   * The workspace on screen is nothing but its one tab (no panes, no draft text): going to a
   * workspace with no tab yet takes that tab along (it navigates, with history) instead of
   * leaving it behind empty.
   */
  reuse?: boolean
}

function insertAfter(tabs: Tabs, at: number, place: Place): Tabs {
  const tab: Tab = { id: tabs.nextId, here: place, back: [], forward: [], pinned: false }
  const pinned = tabs.list.filter((t) => t.pinned).length
  const ix = Math.max(at + 1, pinned)
  const list = [...tabs.list]
  list.splice(ix, 0, tab)
  return { ...tabs, list, active: ix, nextId: tabs.nextId + 1, fresh: false }
}

/**
 * Opens `place` without moving a tab that holds anything to another workspace: a tab already
 * showing it comes forward; in an assistant's workspace another chat opens as a tab beside its
 * thread; a page or chat workspace's tab navigates (with history). A place of another workspace
 * shows there: its tab, else its tab navigated (pages), else the tab in front when the workspace
 * on screen is nothing but that tab (`reuse`), else a new tab in it.
 */
export function routeTo(tabs: Tabs, place: Place, o: RouteOptions): Tabs {
  const probe: Tab = { id: tabs.nextId, here: place, back: [], forward: [], pinned: false }
  const target = o.wsOf(probe)
  const open = tabs.list.find((t) => samePlace(t.here, place) && (t.pinned || o.wsOf(t) === target))
  if (open) return switchTo(tabs, open.id)
  const assistant = isAssistantWorkspace(target)
  if (target === o.front) {
    if (o.newTab || assistant) return insertAfter(tabs, tabs.active, place)
    return navigate(tabs, place)
  }
  const own = tabs.list
    .map((t, i) => [t, i] as const)
    .filter(([t]) => !t.pinned && o.wsOf(t) === target)
  if (own.length > 0 && !assistant && !o.newTab) {
    return navigate(switchTo(tabs, own[0]![0].id), place)
  }
  if (own.length === 0 && o.reuse && !o.newTab) return navigate(tabs, place)
  const after = own.length > 0 ? own[own.length - 1]![1] : tabs.list.length - 1
  return insertAfter(tabs, after, place)
}

// The saved record (layout.json `workspaces`) ------------------------------------------------

export interface Workspaces {
  /** The workspace on screen when saved. */
  front: string | null
  /** Tool tabs pinned to every workspace, in pin order. */
  pinned: ToolTab[]
  /** Each workspace's own layout (dockview's toJSON, pinned tabs left out). */
  layouts: Record<string, DockJson>
  /** Workspaces, most recently shown first: the oldest leave first past the cap. */
  order: string[]
}

/** How many workspaces keep a layout; assistants always keep theirs. */
export const WORKSPACE_CAP = 60

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isDock = (v: unknown): v is DockJson =>
  isObject(v) && isObject(v['grid']) && isObject(v['panels'])

/** The saved record, or null when there is none (or it is not one). Never throws. */
export function readWorkspaces(v: unknown): Workspaces | null {
  if (!isObject(v) || v['v'] !== 1) return null
  const layouts: Record<string, DockJson> = {}
  if (isObject(v['layouts'])) {
    for (const [ws, json] of Object.entries(v['layouts'])) if (isDock(json)) layouts[ws] = json
  }
  const pinned: ToolTab[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(v['pinned']) ? v['pinned'] : []) {
    const t = toolTabFromJson(raw)
    if (t && !seen.has(toolTabId(t))) {
      seen.add(toolTabId(t))
      pinned.push(t)
    }
  }
  const order = (Array.isArray(v['order']) ? v['order'] : []).filter(
    (x): x is string => typeof x === 'string',
  )
  return {
    front: typeof v['front'] === 'string' ? v['front'] : null,
    pinned,
    layouts,
    order,
  }
}

/** The record as layout.json keeps it, past the cap the oldest non-assistant layouts dropped. */
export function saveWorkspaces(w: Workspaces): Record<string, unknown> {
  const order = [...new Set([...w.order, ...Object.keys(w.layouts)])]
  const kept: string[] = []
  let others = 0
  for (const ws of order) {
    if (!w.layouts[ws]) continue
    if (!isAssistantWorkspace(ws) && ++others > WORKSPACE_CAP) continue
    kept.push(ws)
  }
  const layouts: Record<string, DockJson> = {}
  for (const ws of kept) layouts[ws] = w.layouts[ws]!
  return { v: 1, front: w.front, pinned: w.pinned, layouts, order: kept }
}

// From the single window layout --------------------------------------------------------------

/**
 * The window's one layout (before workspaces) as the layout of `front`, the workspace on screen
 * at first launch: another workspace's page beside it becomes a page tab of this one (its app tab
 * closes), any other workspace's tab leaves this layout (it opens in its own). Every other
 * workspace starts empty.
 */
export function migrateWindowLayout(
  dock: unknown,
  tabs: Tabs,
  wsOf: (t: Tab) => string,
  front: string,
): { layout: unknown; tabs: Tabs } {
  if (!isDock(dock)) return { layout: dock, tabs }
  // A deep copy of plain JSON (shell-core has no DOM or Node globals).
  const json = JSON.parse(JSON.stringify(dock)) as DockJson
  const groups = dockGroups(json.grid.root)
  const active = tabs.list[tabs.active]
  const home = groups.find((g) => active && g.views.includes(appPanelId(active.id)))
  const gone = new Set<number>()
  for (const g of groups) {
    g.views = g.views.flatMap((v) => {
      const n = appTabOf(v)
      if (n === null) return [v]
      const t = tabs.list.find((x) => x.id === n)
      if (!t || t.pinned || wsOf(t) === front) return [v]
      const page = t.here.page !== 'chat' && !t.here.page.startsWith('agent:')
      if (g === home || !page) return []
      const view = pageTab(t.here)
      const id = toolTabId(view)
      json.panels[id] = toolPanelJson(view, json.panels[v]?.title ?? id)
      gone.add(n)
      if (g.activeView === v) g.activeView = id
      return [id]
    })
    if (g.activeView !== undefined && !g.views.includes(g.activeView)) {
      if (g.views[0] === undefined) delete g.activeView
      else g.activeView = g.views[0]
    }
  }
  if (gone.size === 0) return { layout: json, tabs }
  const keep = tabs.list.filter((t) => !gone.has(t.id))
  const activeId = active?.id
  const ix = keep.findIndex((t) => t.id === activeId)
  return { layout: json, tabs: { ...tabs, list: keep, active: ix < 0 ? 0 : ix } }
}
