import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type {
  AddPanelPositionOptions,
  DockviewApi,
  DockviewGroupPanel,
  IDockviewPanel,
  Position,
} from 'dockview-react'
import {
  APP_PANEL,
  GAP,
  MAIN_MIN,
  TILE_MIN_H,
  TILE_MIN_W,
  TOOL_KINDS,
  TOOL_PANE_SHARE,
  TOOL_PANEL,
  activeTab,
  appPanelId,
  appTabOf,
  closeTab as closeTabIn,
  defaultDock,
  dockRects,
  dockShape,
  migrateTiling,
  neighbor,
  openNewChat,
  reconcileDock,
  samePlace,
  shapeMinWidth,
  switchTo,
  toolTabFromJson,
  toolTabId,
  type DockJson,
  type DockShape,
  type ExperimentArmTab,
  type LegacyPanel,
  type Place,
  type Rect,
  type Side,
  type SubagentTab,
  type Tab,
  type Tabs,
  type ToolKind,
  type ToolTab,
} from '@evaos/shell-core'
import { invoke } from '../ipc'
import { registerAction } from '../hotkeys/router'
import { focusedPane } from '../hotkeys/pane-focus'
import { tabTitle } from '../tabs/tab-meta'
import { navigateTo, tabsStore, updateTabs } from '../tabs/tabs-store'
import { LAYOUT_EVENT } from './layout-event'
import { paneTabTitle } from './pane-tab-meta'

/**
 * The window's panes, on dockview (tiling/dock renders it). Every layout change goes through
 * here: Isaac's drags and shortcuts, the app's own reveals (a link opens the browser) and agent
 * actions. Each app tab of the tabs store is a panel (`tab:<id>`), each tool tab a panel named by
 * its tool tab id; a pane is a dockview group. The layout persists to layout.json (`dock`, the
 * engine's own toJSON) a moment after each change.
 */
export interface PaneView {
  /** The group's id (`p<n>`). */
  id: string
  /** Panel ids in tab order. */
  views: string[]
  /** The panel in front. */
  active: string | null
  /** Px inside the panes area, as last laid out; null while hidden by a maximized pane. */
  rect: Rect | null
  /** It holds an app tab (a chat or a page): the main column's look, room for a chat. */
  app: boolean
}

export interface TilingState {
  /** The saved layout is in place (or a default one). */
  loaded: boolean
  /** Every pane, in layout order. */
  panes: PaneView[]
  /** The pane keyboard actions and new tabs go to. */
  focus: string | null
  /** The pane maximized over the others, if any. */
  zoom: string | null
  /**
   * The pane the window chrome leads with: the top-left pane holding an app tab. Its chat or
   * page header carries the sidebar and panel toggles, its tab strip clears the traffic lights.
   */
  lead: string | null
  /** The browser scope in front: what the active app tab shows. Tool tabs show this scope. */
  scope: string
  /** The smallest width the panes on screen take, gaps included (the sidebar folds for it). */
  contentMin: number
}

const initialState = (): TilingState => ({
  loaded: false,
  panes: [],
  focus: null,
  zoom: null,
  lead: null,
  scope: '',
  contentMin: MAIN_MIN + GAP + TILE_MIN_W,
})

export const tilingStore = createStore<TilingState>(initialState)

export function useTiling<T>(selector: (s: TilingState) => T): T {
  return useStore(tilingStore, selector)
}

function fail(code: 'not-found' | 'not-allowed' | 'invalid-params', message: string): never {
  throw Object.assign(new Error(message), { code })
}

// The engine ------------------------------------------------------------------------------------

let api: DockviewApi | null = null
let root: HTMLElement | null = null
/** What layout.json held, until the dock and the tabs are both there to build from it. */
let saved: SavedLayout | null = null
/** The app tab the dock last showed as active; tabs-store changes beyond it come forward. */
let syncedActive: number | null = null
/** Inside a sync either way: the other side's events are ours, not Isaac's. */
let syncing = false
/**
 * Where the next new app tab goes (a split, a pane's + button), once. `front`: it shows in front
 * of that pane and the pane takes the focus, but the active app tab stays (a link opened beside a
 * chat leaves the chat's browser scope in front, as tool panes always did).
 */
let hint: { position: AddPanelPositionOptions; share?: number; front?: boolean } | null = null
/** A closed tab's successor came from another pane: it becomes active without taking focus. */
let quietActive = false
let groupSeq = 0

export interface SavedLayout {
  dock: unknown
  tiling: unknown
  legacy: LegacyPanel | null
  sidebarWidth: number
}

const titleOf = (tabs: Tabs, id: string): string => {
  const n = appTabOf(id)
  if (n !== null) {
    const tab = tabs.list.find((t) => t.id === n)
    return tab ? tabTitle(tab.here) : id
  }
  const tool = toolTabFromJson(api?.getPanel(id)?.params?.['tab'])
  return tool ? paneTabTitle(tool) : id
}

/** A new group's id: `p<n>`, after every id in use. */
export function nextGroupId(): string {
  for (const g of api?.groups ?? []) {
    const m = /^p(\d+)$/.exec(g.id)
    if (m) groupSeq = Math.max(groupSeq, Number(m[1]))
  }
  groupSeq += 1
  return `p${groupSeq}`
}

/** DockRoot hands over the engine and its element; the saved layout goes in once tabs load. */
export function attachDock(dock: DockviewApi, element: HTMLElement): () => void {
  api = dock
  root = element
  const offs = [
    dock.onDidLayoutChange(() => {
      refresh()
      scheduleSave()
    }),
    dock.onDidActiveGroupChange(() => refresh()),
    dock.onDidMaximizedGroupChange(() => refresh()),
    dock.onDidActivePanelChange((e) => {
      const panel = 'panel' in e ? e.panel : (e as IDockviewPanel | undefined)
      onActivePanel(panel)
    }),
    dock.onDidAddPanel(() => refresh()),
    dock.onDidRemovePanel(() => refresh()),
    dock.onDidMovePanel(() => refresh()),
  ]
  build()
  return () => {
    offs.forEach((o) => o.dispose())
    if (api === dock) {
      api = null
      root = null
    }
  }
}

/** layout.load's answer: built as soon as the dock and the tabs are there. */
export function applySavedLayout(layout: SavedLayout): void {
  saved = layout
  build()
}

function build(): void {
  const tabsState = tabsStore.getState()
  if (!api || !root || !saved || !tabsState.loaded || tilingStore.getState().loaded) return
  const from = saved
  saved = null
  let tabs = tabsState.tabs
  const box = {
    width: Math.max(root.clientWidth, 1) || window.innerWidth,
    height: Math.max(root.clientHeight, 1) || window.innerHeight,
  }
  let json = reconcileDock(from.dock, tabs, (id) => titleOf(tabs, id))
  let save = json === null
  if (!json && from.tiling) {
    const migrated = migrateTiling(from.tiling, tabs, box, titleOf)
    if (migrated) {
      json = migrated.dock
      if (migrated.tabs !== tabs) {
        tabs = migrated.tabs
        tabsStore.setState({ tabs })
      }
    }
  }
  if (!json) {
    const room = window.innerWidth - from.sidebarWidth - 3 * GAP
    const share = from.legacy
      ? from.legacy.width / Math.max(room, from.legacy.width + MAIN_MIN)
      : TOOL_PANE_SHARE
    json = defaultDock(tabs, box, (id) => titleOf(tabs, id), share, from.legacy?.tool ?? 'browser')
  }
  syncing = true
  try {
    api.fromJSON(json as unknown as Parameters<DockviewApi['fromJSON']>[0])
  } finally {
    syncing = false
  }
  syncedActive = activeTab(tabs).id
  tilingStore.setState({ loaded: true })
  refresh()
  if (save) saveNow()
  else lastSaved = JSON.stringify(api.toJSON())
}

// Snapshot ------------------------------------------------------------------------------------

function groupHasApp(g: DockviewGroupPanel): boolean {
  return g.panels.some((p) => appTabOf(p.id) !== null)
}

/** Reads the engine into the store, and marks each group's element for styling and tests. */
function refresh(): void {
  if (!api || !root) return
  const origin = root.getBoundingClientRect()
  const json = api.toJSON() as unknown as DockJson
  const laid = dockRects(json)
  const maximized = api.hasMaximizedGroup()
    ? (api.groups.find((g) => g.api.isMaximized())?.id ?? null)
    : null
  const panes: PaneView[] = api.groups.map((g) => {
    const m = /^p(\d+)$/.exec(g.id)
    if (m) groupSeq = Math.max(groupSeq, Number(m[1]))
    const b = g.element.getBoundingClientRect()
    const hidden = maximized !== null && maximized !== g.id
    // Before the first paint (and in tests) the DOM has no size yet: the saved sizes stand in.
    const box =
      b.width > 0
        ? { x: b.left - origin.left, y: b.top - origin.top, w: b.width, h: b.height }
        : laid[g.id]
    return {
      id: g.id,
      views: g.panels.map((p) => p.id),
      active: g.activePanel?.id ?? null,
      rect:
        hidden || !box
          ? null
          : {
              x: Math.round(box.x),
              y: Math.round(box.y),
              w: Math.round(box.w),
              h: Math.round(box.h),
            },
      app: groupHasApp(g),
    }
  })
  const focus = api.activeGroup?.id ?? panes[0]?.id ?? null
  const shown = panes.filter((p) => maximized === null || p.id === maximized)
  const leadPane = shown
    .filter((p) => p.app)
    .sort((a, b) => (a.rect?.y ?? 0) - (b.rect?.y ?? 0) || (a.rect?.x ?? 0) - (b.rect?.x ?? 0))[0]
  const shape = dockShape(json)
  const zoomed = maximized === null ? null : findShapePane(shape, maximized)
  const contentMin = shapeMinWidth(zoomed ?? shape)
  const many = shown.length > 1
  for (const g of api.groups) {
    const el = g.element
    const app = groupHasApp(g)
    el.dataset['paneId'] = g.id
    el.dataset['paneKind'] = app ? 'app' : 'tool'
    el.dataset['testid'] = `pane-${g.id}`
    if (many && g.id === focus) el.dataset['focused'] = 'true'
    else delete el.dataset['focused']
    if (g.id === leadPane?.id) el.dataset['lead'] = 'true'
    else delete el.dataset['lead']
    const view = panes.find((p) => p.id === g.id)
    if (view?.rect?.y === 0) el.dataset['top'] = 'true'
    else delete el.dataset['top']
    const header = el.querySelector<HTMLElement>(':scope > .dv-tabs-and-actions-container')
    if (header) header.dataset['testid'] = g.id === leadPane?.id ? 'tabbar' : `pane-header-${g.id}`
    const body = el.querySelector<HTMLElement>(':scope > .dv-content-container')
    if (body) body.dataset['testid'] = `pane-body-${g.id}`
    const minimumWidth = app ? MAIN_MIN : TILE_MIN_W
    if (g.minimumWidth !== minimumWidth) {
      g.api.setConstraints({ minimumWidth, minimumHeight: TILE_MIN_H })
    }
  }
  const prev = tilingStore.getState()
  const next = { panes, focus, zoom: maximized, lead: leadPane?.id ?? null, contentMin }
  if (JSON.stringify([prev.panes, prev.focus, prev.zoom, prev.lead, prev.contentMin]) !==
    JSON.stringify([next.panes, next.focus, next.zoom, next.lead, next.contentMin])) {
    tilingStore.setState(next)
  }
  // A tab moved to another pane can land somewhere else at the same size: slots re-measure.
  window.dispatchEvent(new Event(LAYOUT_EVENT))
}

function findShapePane(shape: DockShape, id: string): DockShape | null {
  if (shape.type === 'pane') return shape.id === id ? shape : null
  for (const c of shape.children) {
    const hit = findShapePane(c, id)
    if (hit) return hit
  }
  return null
}

function groupOf(panelId: string): DockviewGroupPanel | null {
  return api?.getPanel(panelId)?.group ?? null
}

/** Group `id` (dockview's getGroup answers a narrower interface). */
function groupById(id: string): DockviewGroupPanel | undefined {
  return api?.groups.find((g) => g.id === id)
}

function paneOf(id: string): DockviewGroupPanel {
  const g = groupById(id)
  if (!g) fail('not-found', `No pane ${id}`)
  return g
}

/** The panes on screen: the maximized one alone, else all. */
export function visiblePanes(s: TilingState = tilingStore.getState()): PaneView[] {
  return s.panes.filter((p) => s.zoom === null || p.id === s.zoom)
}

/** More than one pane on screen: the panel toggle reads "Hide tool panes". */
export const toolsShown = (s: TilingState): boolean => visiblePanes(s).length > 1

/** The tool tabs in front of a pane on screen. */
export function frontToolTabs(s: TilingState = tilingStore.getState()): ToolTab[] {
  const out: ToolTab[] = []
  for (const p of visiblePanes(s)) {
    const tab = p.active === null ? null : toolTabOfId(p.active)
    if (tab) out.push(tab)
  }
  return out
}

/** The tool tab an open panel shows. */
export function toolTabOfId(id: string): ToolTab | null {
  const panel = api?.getPanel(id)
  return panel ? toolTabFromJson(panel.params?.['tab']) : null
}

// Tabs store <-> dock ---------------------------------------------------------------------------

function onActivePanel(panel: IDockviewPanel | undefined): void {
  refresh()
  if (syncing || !panel) return
  const n = appTabOf(panel.id)
  if (n === null) return
  syncedActive = n
  const tabs = tabsStore.getState().tabs
  if (activeTab(tabs).id !== n) updateTabs((t) => switchTo(t, n))
}

function appPanelOptions(tab: Tab) {
  return {
    id: appPanelId(tab.id),
    component: APP_PANEL,
    tabComponent: APP_PANEL,
    title: tabTitle(tab.here),
    params: {},
  }
}

/** Where a new app tab goes: the hint, else after the app tab that was active. */
function placeFor(): { position?: AddPanelPositionOptions; share?: number; front?: boolean } {
  if (hint) {
    const h = hint
    hint = null
    return h
  }
  const anchor = syncedActive === null ? undefined : api?.getPanel(appPanelId(syncedActive))
  if (anchor) {
    const index = anchor.group.panels.indexOf(anchor) + 1
    return { position: { referenceGroup: anchor.group, index } }
  }
  const group = api?.activeGroup ?? api?.groups[0]
  return group ? { position: { referenceGroup: group } } : {}
}

/** Puts the tabs store's tabs on the dock: new ones open, closed ones go, the active comes forward. */
function syncFromTabs(): void {
  const tabsState = tabsStore.getState()
  if (!api || !tilingStore.getState().loaded || syncing) return
  const { tabs } = tabsState
  const dock = api
  syncing = true
  try {
    const active = activeTab(tabs)
    for (const tab of tabs.list) {
      if (dock.getPanel(appPanelId(tab.id))) continue
      const { position, share, front } = placeFor()
      const panel = dock.addPanel({
        ...appPanelOptions(tab),
        ...(position ? { position } : {}),
        inactive: tab.id !== active.id && !front,
      })
      if (share !== undefined) sizeShare(panel.group, share)
    }
    const live = new Set(tabs.list.map((t) => appPanelId(t.id)))
    for (const panel of [...dock.panels]) {
      if (appTabOf(panel.id) !== null && !live.has(panel.id)) dock.removePanel(panel)
    }
    pinnedFirst(tabs)
    for (const tab of tabs.list) {
      const panel = dock.getPanel(appPanelId(tab.id))
      if (panel && panel.title !== tabTitle(tab.here)) panel.api.setTitle(tabTitle(tab.here))
    }
    if (active.id !== syncedActive) {
      syncedActive = active.id
      const panel = dock.getPanel(appPanelId(active.id))
      if (panel && !quietActive) {
        if (zoomHides(panel.group)) dock.exitMaximizedGroup()
        panel.api.setActive()
      }
    }
    quietActive = false
  } finally {
    syncing = false
  }
  refresh()
}

/** Pinned app tabs lead their pane's strip, like the tab bar kept them. */
function pinnedFirst(tabs: Tabs): void {
  if (!api) return
  const pinned = new Set(tabs.list.filter((t) => t.pinned).map((t) => appPanelId(t.id)))
  for (const g of api.groups) {
    const order = g.panels.map((p) => p.id)
    const want = [...order.filter((id) => pinned.has(id)), ...order.filter((id) => !pinned.has(id))]
    want.forEach((id, index) => {
      const panel = g.panels.find((p) => p.id === id)
      if (panel && g.panels.indexOf(panel) !== index) {
        panel.api.moveTo({ group: g, index, skipSetActive: true })
      }
    })
  }
}

function zoomHides(group: DockviewGroupPanel): boolean {
  return !!api?.hasMaximizedGroup() && !group.api.isMaximized()
}

/** Gives `group` `share` of its parent split's length. */
function sizeShare(group: DockviewGroupPanel, share: number): void {
  if (!api) return
  const shape = dockShape(api.toJSON() as unknown as DockJson)
  const parent = parentSplit(shape, group.id)
  if (!parent) return
  const length = parent.split.children.reduce((a, c) => a + c.size, 0)
  if (parent.split.dir === 'row') group.api.setSize({ width: Math.round(length * share) })
  else group.api.setSize({ height: Math.round(length * share) })
}

function parentSplit(
  shape: DockShape,
  id: string,
): { split: Extract<DockShape, { type: 'split' }>; index: number } | null {
  if (shape.type === 'pane') return null
  const index = shape.children.findIndex((c) => c.type === 'pane' && c.id === id)
  if (index >= 0) return { split: shape, index }
  for (const c of shape.children) {
    const hit = parentSplit(c, id)
    if (hit) return hit
  }
  return null
}

// App tabs --------------------------------------------------------------------------------------

/**
 * Closes app tab `id`. When it is the active one, the tab beside it in its pane comes forward;
 * with none there, the tabs store's next tab becomes active without taking the focus.
 */
export function closeAppTab(id: number): void {
  const tabs = tabsStore.getState().tabs
  if (!tabs.list.some((t) => t.id === id)) return
  let next: number | null = null
  if (activeTab(tabs).id === id && api) {
    const panel = api.getPanel(appPanelId(id))
    if (panel) {
      const siblings = panel.group.panels
      const at = siblings.indexOf(panel)
      const beside = siblings[at + 1] ?? siblings[at - 1]
      next = beside ? appTabOf(beside.id) : null
      if (next === null && tabs.list.length > 1) quietActive = true
    }
  }
  updateTabs((t) => {
    const closed = closeTabIn(t, id)
    return next === null ? closed : switchTo(closed, next)
  })
}

/** A new chat tab at the end of `pane` (the active app tab's pane by default). */
export function newChatTabIn(pane?: string): void {
  const group =
    (pane ? groupById(pane) : undefined) ??
    (syncedActive === null ? undefined : groupOf(appPanelId(syncedActive))) ??
    undefined
  if (group) hint = { position: { referenceGroup: group, index: group.panels.length } }
  updateTabs(openNewChat)
}

/**
 * Brings panel `id` to the front of its pane and focuses that pane without making it the active
 * app tab (see `hint.front`).
 */
function showQuietly(id: string, into?: DockviewGroupPanel): void {
  const panel = api?.getPanel(id)
  if (!api || !panel) return
  syncing = true
  try {
    if (into && panel.group !== into) panel.api.moveTo({ group: into })
    if (zoomHides(panel.group)) api.exitMaximizedGroup()
    panel.api.setActive()
  } finally {
    syncing = false
  }
  refresh()
}

/**
 * Opens `place` in a pane right of the app tab in front: a tab of the pane there when one is,
 * else a new pane split off at the tool pane's share. A place already open comes forward. The
 * app tab in front stays the active one (its browser scope stays), the new pane has the focus.
 */
export function openPlaceBeside(place: Place): void {
  const open = tabsStore.getState().tabs.list.find((t) => samePlace(t.here, place))
  if (open) {
    showQuietly(appPanelId(open.id))
    return
  }
  const origin =
    (syncedActive === null ? null : groupOf(appPanelId(syncedActive))) ?? api?.activeGroup
  if (api && origin) {
    const right = neighbor(rectsById(), origin.id, 'right')
    const group = right ? groupById(right) : undefined
    hint = group
      ? { position: { referenceGroup: group }, front: true }
      : {
          position: { referenceGroup: origin, direction: 'right' },
          share: TOOL_PANE_SHARE,
          front: true,
        }
  }
  updateTabs((t) => insertTab(t, place))
}

/**
 * Opens `place` in the focused pane: navigates the app tab in front of it, or adds a tab when a
 * tool tab is in front there.
 */
export function openPlaceHere(place: Place): void {
  const group = api?.activeGroup
  const front = group?.activePanel
  if (!api || !group || !front || appTabOf(front.id) !== null) {
    navigateTo(place)
    return
  }
  const open = tabsStore.getState().tabs.list.find((t) => samePlace(t.here, place))
  if (open) {
    showQuietly(appPanelId(open.id), group)
    return
  }
  hint = {
    position: { referenceGroup: group, index: group.panels.indexOf(front) + 1 },
    front: true,
  }
  updateTabs((t) => insertTab(t, place))
}

/** Shows `place` as a tab of `pane` (a pane's + menu): moved there when it is open elsewhere. */
export function openPlaceInPane(place: Place, pane: string): void {
  const group = paneOf(pane)
  const open = tabsStore.getState().tabs.list.find((t) => samePlace(t.here, place))
  if (open) {
    showQuietly(appPanelId(open.id), group)
    return
  }
  const front = group.activePanel
  hint = {
    position: {
      referenceGroup: group,
      index: front ? group.panels.indexOf(front) + 1 : group.panels.length,
    },
    front: true,
  }
  updateTabs((t) => insertTab(t, place))
}

/** A new app tab on `place` with no history after the active one, which stays active. */
function insertTab(t: Tabs, place: Place): Tabs {
  const tab: Tab = { id: t.nextId, here: place, back: [], forward: [], pinned: false }
  const pinned = t.list.filter((x) => x.pinned).length
  const at = Math.max(t.active + 1, pinned)
  const list = [...t.list]
  list.splice(at, 0, tab)
  return { ...t, list, nextId: t.nextId + 1, fresh: false }
}

// Tool tabs -------------------------------------------------------------------------------------

/** The pane a new tool tab goes to: the focused tool pane, the one right of the app tabs, any. */
function preferredToolPane(): DockviewGroupPanel | null {
  if (!api) return null
  const tools = api.groups.filter((g) => !groupHasApp(g))
  const focus = api.activeGroup
  if (focus && tools.includes(focus)) return focus
  return tools[0] ?? null
}

/**
 * Shows a tool tab: in front where it already is, else in `pane` (or the preferred tool pane);
 * with no tool pane, a new one opens right of the app tabs. Naming a pane moves an open tab
 * there. Answers the pane that holds it.
 */
export function openTab(tab: ToolTab, pane?: string): string {
  if (!api) fail('not-found', 'The panes are not ready')
  const dock = api
  const id = toolTabId(tab)
  const title = paneTabTitle(tab)
  const target = pane === undefined ? null : paneOf(pane)
  let panel = dock.getPanel(id)
  if (panel) {
    // A transient view's details (its label) follow the latest open.
    panel.api.updateParameters({ tab })
    if (panel.title !== title) panel.api.setTitle(title)
    if (target && panel.group !== target) panel.api.moveTo({ group: target })
  } else {
    const into = target ?? preferredToolPane()
    const anchor =
      (syncedActive === null ? undefined : dock.getPanel(appPanelId(syncedActive))?.group) ??
      dock.activeGroup
    const position: AddPanelPositionOptions | undefined = into
      ? { referenceGroup: into }
      : anchor
        ? { referenceGroup: anchor, direction: 'right' }
        : undefined
    panel = dock.addPanel({
      id,
      component: TOOL_PANEL,
      tabComponent: TOOL_PANEL,
      title,
      params: { tab },
      ...(position ? { position } : {}),
    })
    if (!into) sizeShare(panel.group, TOOL_PANE_SHARE)
  }
  if (zoomHides(panel.group)) dock.exitMaximizedGroup()
  panel.api.setActive()
  refresh()
  return panel.group.id
}

export function revealTool(kind: ToolKind): string {
  return openTab({ kind })
}

export function openSubagentTab(view: Omit<SubagentTab, 'kind'>): string {
  return openTab({ kind: 'subagent', ...view })
}

export function openArmTab(view: Omit<ExperimentArmTab, 'kind'>): string {
  return openTab({ kind: 'experiment-arm', ...view })
}

/** Brings panel `id` (`tab:<n>` or a tool tab id) to the front of its pane, and focuses that. */
export function activateTab(id: string): void {
  const panel = api?.getPanel(id)
  if (!api || !panel) fail('not-found', `No tab ${id}`)
  if (zoomHides(panel.group)) api.exitMaximizedGroup()
  panel.api.setActive()
}

/** Closes panel `id`: an app tab through the tabs store, a tool tab here. */
export function closeTab(id: string): void {
  const n = appTabOf(id)
  if (n !== null) {
    if (!tabsStore.getState().tabs.list.some((t) => t.id === n)) fail('not-found', `No tab ${id}`)
    closeAppTab(n)
    return
  }
  const panel = api?.getPanel(id)
  if (!api || !panel) fail('not-found', `No tab ${id}`)
  api.removePanel(panel)
}

/** Moves panel `id` into `toPane` at `index` (default after the tab in front there). */
export function moveTab(id: string, toPane: string, index?: number): void {
  const panel = api?.getPanel(id)
  if (!panel) fail('not-found', `No tab ${id}`)
  const group = paneOf(toPane)
  const front = group.activePanel ? group.panels.indexOf(group.activePanel) + 1 : group.panels.length
  const at = Math.min(Math.max(Math.trunc(index ?? front), 0), group.panels.length)
  panel.api.moveTo({ group, index: at })
  panel.api.setActive()
}

/** Tab `id` is in front of a pane on screen. */
export function tabVisible(id: string): boolean {
  const s = tilingStore.getState()
  return visiblePanes(s).some((p) => p.active === id)
}

/** Tab `id` is in front of the pane that has the keyboard focus. */
export function tabFocused(id: string): boolean {
  const pane = focusedPane()
  return pane !== null && tilingStore.getState().panes.some((p) => p.id === pane && p.active === id)
}

// Panes -----------------------------------------------------------------------------------------

const POSITION: Record<Side, Position> = { left: 'left', right: 'right', up: 'top', down: 'bottom' }
const DIRECTION = { left: 'left', right: 'right', up: 'above', down: 'below' } as const

/**
 * What a split without a named tab moves over: the pane's tab in front when it has others,
 * else the first tool not open yet.
 */
export function defaultSplitTab(paneId: string): string | ToolTab | null {
  const group = groupById(paneId)
  if (group && group.panels.length > 1 && group.activePanel) return group.activePanel.id
  const missing = TOOL_KINDS.find((kind) => !api?.getPanel(kind))
  return missing ? { kind: missing } : null
}

/**
 * Splits `paneId` toward `side` with a new pane showing `what`: an open panel's id (moved there)
 * or a tool tab (opened there). `share` is the new pane's part of the space it splits. Answers
 * the new pane, or null when there was nothing to move.
 */
export function splitAt(
  paneId: string,
  side: Side,
  what?: string | ToolTab,
  share?: number,
): string | null {
  if (!api) fail('not-found', 'The panes are not ready')
  const group = paneOf(paneId)
  const item = what ?? defaultSplitTab(paneId)
  if (item === null) return null
  let panel: IDockviewPanel | undefined
  if (typeof item === 'string') {
    panel = api.getPanel(item)
    if (!panel) fail('not-found', `No tab ${item}`)
    if (panel.group === group && group.panels.length === 1) return group.id
    panel.api.moveTo({ group, position: POSITION[side] })
  } else {
    const id = toolTabId(item)
    panel = api.getPanel(id)
    if (panel) panel.api.moveTo({ group, position: POSITION[side] })
    else {
      panel = api.addPanel({
        id,
        component: TOOL_PANEL,
        tabComponent: TOOL_PANEL,
        title: paneTabTitle(item),
        params: { tab: item },
        position: { referenceGroup: group, direction: DIRECTION[side] },
      })
    }
  }
  if (zoomHides(panel.group)) api.exitMaximizedGroup()
  if (share !== undefined) sizeShare(panel.group, share)
  panel.api.setActive()
  refresh()
  return panel.group.id
}

/**
 * Closes pane `id` and its tabs (app tabs close in the tabs store, which keeps a Dashboard tab
 * when none is left). The pane holding every app tab never closes.
 */
export function closePaneById(id: string): void {
  if (!api) fail('not-found', 'The panes are not ready')
  const group = paneOf(id)
  const apps = group.panels.map((p) => appTabOf(p.id)).filter((n) => n !== null)
  const all = tabsStore.getState().tabs.list.length
  if (apps.length > 0 && apps.length >= all) {
    fail('not-allowed', 'The pane holding every app tab cannot close')
  }
  for (const p of [...group.panels]) if (appTabOf(p.id) === null) api.removePanel(p)
  if (apps.length) {
    const gone = new Set(apps)
    quietActive = gone.has(activeTab(tabsStore.getState().tabs).id)
    updateTabs((t) => apps.reduce((acc, n) => closeTabIn(acc, n), t))
    if (!gone.has(activeTab(tabsStore.getState().tabs).id)) quietActive = false
  }
}

/** Makes `id` the focused pane (its tab in front becomes the active panel). */
export function focusPaneById(id: string): void {
  if (!api) fail('not-found', 'The panes are not ready')
  const group = paneOf(id)
  if (zoomHides(group)) api.exitMaximizedGroup()
  const front = group.activePanel
  if (front) front.api.setActive()
  refresh()
}

function rectsById(): Record<string, Rect> {
  const out: Record<string, Rect> = {}
  for (const p of tilingStore.getState().panes) if (p.rect) out[p.id] = p.rect
  return out
}

/** Focuses the pane beside the focused one; null when there is none that way. */
export function focusNeighbor(side: Side): string | null {
  const { focus } = tilingStore.getState()
  if (focus === null) return null
  const id = neighbor(rectsById(), focus, side)
  if (id) focusPaneById(id)
  return id
}

/** Maximizes `paneId` (on), shows every pane (off), or toggles. */
export function zoomPane(paneId: string, on?: boolean): void {
  if (!api) fail('not-found', 'The panes are not ready')
  const group = paneOf(paneId)
  const want = on ?? !group.api.isMaximized()
  if (want && !group.api.isMaximized()) group.api.maximize()
  else if (!want && api.hasMaximizedGroup()) api.exitMaximizedGroup()
  refresh()
}

/**
 * The panel toggle (Cmd+Shift+B): hides the other panes by maximizing the active app tab's pane,
 * shows them again, and with that pane alone opens Browser and Files right of it.
 */
export function toggleToolPanes(open?: boolean): void {
  if (!api) return
  const dock = api
  const s = tilingStore.getState()
  const shown = toolsShown(s)
  const want = open ?? !shown
  if (want === shown) return
  const home =
    (syncedActive === null ? null : groupOf(appPanelId(syncedActive))) ??
    dock.activeGroup ??
    dock.groups[0]
  if (!home) return
  if (!want) {
    home.api.maximize()
    refresh()
    return
  }
  if (dock.hasMaximizedGroup() && dock.groups.length > 1) {
    dock.exitMaximizedGroup()
    refresh()
    return
  }
  const browser = splitAt(home.id, 'right', { kind: 'browser' }, TOOL_PANE_SHARE)
  if (browser === null) return
  for (const kind of TOOL_KINDS.slice(1)) {
    const panel = dock.getPanel(kind)
    const target = groupById(browser)
    if (target && panel && panel.group !== target) panel.api.moveTo({ group: target })
    else if (target && !panel) {
      dock.addPanel({
        id: kind,
        component: TOOL_PANEL,
        tabComponent: TOOL_PANEL,
        title: paneTabTitle({ kind }),
        params: { tab: { kind } },
        position: { referenceGroup: target },
        inactive: true,
      })
    }
  }
  dock.getPanel('browser')?.api.setActive()
  refresh()
}

/**
 * Sets a pane's share of its parent split, as a share or px along the split, held so every
 * sibling keeps its minimum size (dockview enforces the minimums).
 */
export function resizeNode(id: string, size: { share: number } | { px: number }): void {
  if (!api) fail('not-found', 'The panes are not ready')
  const group = paneOf(id)
  const parent = parentSplit(dockShape(api.toJSON() as unknown as DockJson), id)
  if (!parent) fail('not-allowed', `Pane ${id} fills the window`)
  const length = parent.split.children.reduce((a, c) => a + c.size, 0)
  const px = 'px' in size ? size.px : size.share * length
  if (parent.split.dir === 'row') group.api.setSize({ width: Math.round(px) })
  else group.api.setSize({ height: Math.round(px) })
  refresh()
}

/** The tree as dockview holds it, read for agents (layout.read). */
export function layoutShape(): DockShape | null {
  return api ? dockShape(api.toJSON() as unknown as DockJson) : null
}

// Keyboard (pane shortcuts move the keyboard focus with the pane focus) -----------------------

function focusDom(paneId: string): void {
  requestAnimationFrame(() => {
    const group = groupById(paneId)
    const frame = group?.element
    if (!frame || frame.contains(document.activeElement)) return
    const target =
      frame.querySelector<HTMLElement>('.dv-content-container [data-testid=composer-input]') ??
      frame.querySelector<HTMLElement>('.dv-content-container') ??
      frame
    if (!target.hasAttribute('tabindex') && target === frame) frame.tabIndex = -1
    target.focus({ preventScroll: true })
  })
}

function splitFocused(side: Side): void {
  const { focus } = tilingStore.getState()
  if (focus === null) return
  const pane = splitAt(focus, side)
  if (pane) focusDom(pane)
}

function focusToward(side: Side): void {
  const pane = focusNeighbor(side)
  if (pane) focusDom(pane)
}

function closeFocused(): void {
  const { focus } = tilingStore.getState()
  if (focus === null) return
  try {
    closePaneById(focus)
  } catch {
    return
  }
  const next = tilingStore.getState().focus
  if (next) focusDom(next)
}

// The scope in front --------------------------------------------------------------------------

/** Each scope's own (unpinned) browser tab ids, as last reported by the host. */
const ownTabs = new Map<string, readonly string[]>()

/** The browser scope in front changed (the active app tab shows another chat or page). */
export function enterScope(scope: string): void {
  if (scope !== tilingStore.getState().scope) tilingStore.setState({ scope })
}

/** A draft chat got its session file: its browser tabs follow it. */
export function renameScope(from: string, to: string): void {
  const own = ownTabs.get(from)
  ownTabs.delete(from)
  if (own !== undefined) ownTabs.set(to, own)
  if (tilingStore.getState().scope === from) tilingStore.setState({ scope: to })
}

/** The host's tabs for `scope`: a tab new in the scope in front brings the browser forward. */
export function reportScopeTabs(scope: string, own: readonly string[]): void {
  const before = ownTabs.get(scope)
  ownTabs.set(scope, own)
  if (scope !== tilingStore.getState().scope) return
  if (before && own.some((id) => !before.includes(id)) && api) revealTool('browser')
}

// Persistence ---------------------------------------------------------------------------------

const SAVE_DELAY = 250
let lastSaved = ''
let timer: number | undefined

function saveNow(): void {
  timer = undefined
  if (!api || !tilingStore.getState().loaded) return
  const json = api.toJSON() as unknown as Record<string, unknown>
  const text = JSON.stringify(json)
  if (text === lastSaved) return
  lastSaved = text
  void invoke('layout.save', { dock: json }).then((r) => {
    if (!r.ok) {
      lastSaved = ''
      console.warn('layout.save (dock) failed', r.error)
    }
  })
}

function scheduleSave(): void {
  if (!tilingStore.getState().loaded || syncing) return
  clearTimeout(timer)
  timer = window.setTimeout(saveNow, SAVE_DELAY)
}

function flushSave(): void {
  if (timer === undefined) return
  clearTimeout(timer)
  saveNow()
}

/** Pane shortcuts, the tabs store's sync and persistence. Returns the unsubscribe. */
export function startTiling(): () => void {
  const offs = [
    registerAction('toggle-panel', () => toggleToolPanes()),
    registerAction('split-right', () => splitFocused('right')),
    registerAction('split-down', () => splitFocused('down')),
    registerAction('focus-pane-left', () => focusToward('left')),
    registerAction('focus-pane-right', () => focusToward('right')),
    registerAction('focus-pane-up', () => focusToward('up')),
    registerAction('focus-pane-down', () => focusToward('down')),
    registerAction('close-pane', closeFocused),
    registerAction('zoom-pane', () => {
      const { focus } = tilingStore.getState()
      if (focus) zoomPane(focus)
    }),
    registerAction('new-tab', () => newChatTabIn()),
    registerAction('close-tab', () => {
      const tab = activeTab(tabsStore.getState().tabs)
      if (!tab.pinned) closeAppTab(tab.id)
    }),
  ]
  const unsubTabs = tabsStore.subscribe((s, prev) => {
    if (s.loaded && !prev.loaded) build()
    else if (s.tabs !== prev.tabs) syncFromTabs()
  })
  window.addEventListener('pagehide', flushSave)
  return () => {
    offs.forEach((off) => off())
    unsubTabs()
    window.removeEventListener('pagehide', flushSave)
    flushSave()
  }
}

/** Test seam. */
export function resetTilingForTests(): void {
  ownTabs.clear()
  lastSaved = ''
  clearTimeout(timer)
  timer = undefined
  saved = null
  syncedActive = null
  syncing = false
  hint = null
  quietActive = false
  groupSeq = 0
  tilingStore.setState(initialState(), true)
}
