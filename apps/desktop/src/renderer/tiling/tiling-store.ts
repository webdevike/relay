import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  createDockview,
  type AddPanelPositionOptions,
  type DockviewApi,
  type DockviewGroupPanel,
  type IDockviewPanel,
  type Position,
} from 'dockview-react'
import {
  APP_PANEL,
  GAP,
  LEGACY_BROWSER_PANEL,
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
  composeWorkspace,
  defaultDock,
  dockGroups,
  dockRects,
  dockShape,
  isAssistantWorkspace,
  isBareLayout,
  isToolKind,
  migrateTiling,
  migrateWindowLayout,
  neighbor,
  openNewChat,
  ownLayout,
  pageTab,
  pageTabPlace,
  placeToJson,
  readWorkspaces,
  reconcileDock,
  samePlace,
  saveWorkspaces,
  shapeMinWidth,
  switchTo,
  toolPanelJson,
  toolTabFromJson,
  toolTabId,
  workspaceHome,
  workspaceTabs,
  type DockJson,
  type DockShape,
  type ExperimentArmTab,
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
import { draftText } from '../chat/drafts'
import { registerAction } from '../hotkeys/router'
import { focusedPane } from '../hotkeys/pane-focus'
import { tabTitle } from '../tabs/tab-meta'
import { navigateTo, tabsStore, updateTabs } from '../tabs/tabs-store'
import { setFrontBareCheck, workspaceOfPlace, workspaceOfTab } from '../tabs/workspace-of'
import { LAYOUT_EVENT } from './layout-event'
import { newPageTab } from './web-tabs'
import { paneTabTitle } from './pane-tab-meta'

/**
 * The window's panes, on dockview (tiling/dock renders it), one workspace at a time (shell-core
 * workspace.ts): an assistant with every session it owns, a plain chat, or a page. Each workspace
 * keeps its own panes; switching chats swaps the whole layout and switching back restores it.
 * Pinned tabs (app or tool) show in every workspace. Every layout change goes through here:
 * Isaac's drags and shortcuts, the app's own reveals and agent actions, which reach a workspace
 * that is not on screen through a hidden engine (inWorkspace). Each app tab of the tabs store is a
 * panel (`tab:<id>`), each tool tab a panel named by its tool tab id; a pane is a dockview group.
 * Layouts persist to layout.json (`workspaces`, plus `dock` for the one on screen) a moment after
 * each change.
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
  /** The saved layouts are in place (or a default one). */
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
  /** The workspace on screen (its key, also its browser scope). */
  scope: string
  /** Tool tabs pinned to every workspace, in pin order. */
  pinned: ToolTab[]
  /** Bumps when a tool tab's details or a workspace not on screen changes. */
  rev: number
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
  pinned: [],
  rev: 0,
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

/** The engine every function acts on: the window's, or a hidden one inside inWorkspace. */
let api: DockviewApi | null = null
let root: HTMLElement | null = null
/** The window's engine while a hidden one stands in for it. */
let liveApi: DockviewApi | null = null
let liveRoot: HTMLElement | null = null
/** What layout.json held, until the dock and the tabs are both there to build from it. */
let saved: SavedLayout | null = null
/** The app tab the dock last showed as active; tabs-store changes beyond it come forward. */
let syncedActive: number | null = null
/** Inside a sync either way: the other side's events are ours, not Isaac's. */
let syncing = false
/**
 * Where the next new app tab goes (a split, a pane's + button), once. `front`: it shows in front
 * of that pane and the pane takes the focus, but the active app tab stays.
 */
let hint: { position: AddPanelPositionOptions; share?: number; front?: boolean } | null = null
/** A closed tab's successor came from another pane: it becomes active without taking focus. */
let quietActive = false
/** A press in the panes; a workspace swap it causes waits until it ends (swapAfterPress). */
let pressed: { before: number | null; dragged: boolean } | null = null
let swapAfterPress = false
let groupSeq = 0

/** Each workspace's own layout (pinned tabs left out), as last saved or shown. */
let layouts: Record<string, DockJson> = {}
/** Workspaces, most recently shown first. */
let order: string[] = []
/** Workspaces shown this session: their tool tabs stay mounted while hidden. */
const warm = new Set<string>()

const headless = (): boolean => liveApi !== null

export interface SavedLayout {
  dock: unknown
  tiling: unknown
  /** The side panel before panes; its tool was `browser`, `files` or `terminal`. */
  legacy: { width: number; tool: string } | null
  sidebarWidth: number
  workspaces?: unknown
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

/**
 * An app tab every workspace shows: a pinned one, or an unsent new chat with text in it (it would
 * be out of reach otherwise: no list shows drafts). Clicking one switches to its workspace.
 */
function everywhere(t: Tab): boolean {
  if (t.pinned) return true
  return isDraftPlace(t.here) && draftText(`draft:${t.id}`).trim() !== ''
}

/**
 * Whether workspace `ws` leaves panel `panelId` out of its own layout: a pinned tool tab (every
 * workspace shows it), or another workspace's tab that every workspace shows (a shortcut to it).
 * A workspace's own pinned tab (Astra's thread, pinned) stays where it put it.
 */
function isGlobalIn(ws: string, panelId: string): boolean {
  const n = appTabOf(panelId)
  if (n !== null) {
    const t = tabsStore.getState().tabs.list.find((x) => x.id === n)
    return t !== undefined && everywhere(t) && workspaceOfTab(t) !== ws
  }
  return tilingStore.getState().pinned.some((t) => toolTabId(t) === panelId)
}

/** The workspace an app tab panel belongs to; null for a tool panel or a closed tab. */
function panelWorkspace(panelId: string): string | null {
  const n = appTabOf(panelId)
  const t = n === null ? undefined : tabsStore.getState().tabs.list.find((x) => x.id === n)
  return t ? workspaceOfTab(t) : null
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
    // A maximized pane is how the tool panes hide: it is saved, so they stay hidden.
    dock.onDidMaximizedGroupChange(() => {
      refresh()
      scheduleSave()
    }),
    dock.onDidActivePanelChange((e) => {
      const panel = 'panel' in e ? e.panel : (e as IDockviewPanel | undefined)
      onActivePanel(panel)
    }),
    dock.onDidAddPanel(() => refresh()),
    dock.onDidRemovePanel(() => refresh()),
    dock.onDidMovePanel(() => refresh()),
    // A pinned tab of another workspace (a shortcut to it) only moves within its strip: two
    // workspaces never sit side by side.
    dock.onWillShowOverlay((e) => {
      if (!dropAllowed(e.getData()?.panelId ?? null, e.group?.id, e.kind)) e.preventDefault()
    }),
    dock.onWillDrop((e) => {
      if (!dropAllowed(e.getData()?.panelId ?? null, e.group?.id, e.kind)) e.preventDefault()
    }),
    dock.onWillDragPanel(() => {
      if (pressed) pressed.dragged = true
    }),
  ]
  // A press in the panes (a tab to click or drag) holds any workspace swap until it ends: a
  // swap disposes the engine, which must not happen under a drag.
  const onDown = (): void => {
    pressed = { before: syncedActive, dragged: false }
  }
  const onUp = (): void => {
    const p = pressed
    pressed = null
    if (!p) return
    // After dockview has finished the click or the drop.
    window.setTimeout(() => {
      if (!swapAfterPress) return
      swapAfterPress = false
      // Dragging another workspace's shortcut is not a click on it: the tab in front before the
      // press comes back, and the workspace stays.
      if (p.dragged && p.before !== null && api?.getPanel(appPanelId(p.before))) {
        const before = p.before
        syncedActive = before
        updateTabs((t) => switchTo(t, before))
        showQuietly(appPanelId(before))
        return
      }
      syncFromTabs()
    }, 0)
  }
  element.addEventListener('pointerdown', onDown, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onUp, true)
  build()
  return () => {
    offs.forEach((o) => o.dispose())
    element.removeEventListener('pointerdown', onDown, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onUp, true)
    if (api === dock) {
      api = null
      root = null
    }
  }
}

/** Whether panel `id` may land in `group` (`kind`: dockview's drop location). */
export function dropAllowed(id: string | null, group: string | undefined, kind: string): boolean {
  if (id === null) return true
  const ws = panelWorkspace(id)
  if (ws === null || ws === tilingStore.getState().scope) return true
  const from = api?.getPanel(id)?.group.id
  return group !== undefined && group === from && (kind === 'tab' || kind === 'header_space')
}

/** layout.load's answer: built as soon as the dock and the tabs are there. */
export function applySavedLayout(layout: SavedLayout): void {
  saved = layout
  build()
}

function box(): { width: number; height: number } {
  return {
    width: api?.width || root?.clientWidth || window.innerWidth,
    height: api?.height || root?.clientHeight || window.innerHeight,
  }
}

/** The window's one layout from before workspaces (or a fresh one), for the workspace in front. */
function windowLayout(from: SavedLayout, tabs: Tabs): { json: DockJson; tabs: Tabs } {
  const titles = (id: string): string => titleOf(tabs, id)
  let json = reconcileDock(from.dock, tabs, titles)
  if (!json && from.tiling) {
    const migrated = migrateTiling(from.tiling, tabs, box(), titleOf)
    if (migrated) {
      json = migrated.dock
      tabs = migrated.tabs
    }
  }
  if (!json) {
    const room = window.innerWidth - from.sidebarWidth - 3 * GAP
    const share = from.legacy
      ? from.legacy.width / Math.max(room, from.legacy.width + MAIN_MIN)
      : TOOL_PANE_SHARE
    const tool = from.legacy && isToolKind(from.legacy.tool) ? from.legacy.tool : 'files'
    json = defaultDock(tabs, box(), titles, share, tool)
  }
  return { json, tabs }
}

function build(): void {
  const tabsState = tabsStore.getState()
  if (!api || !root || !saved || !tabsState.loaded || tilingStore.getState().loaded) return
  const from = saved
  saved = null
  let tabs = tabsState.tabs
  const record = readWorkspaces(from.workspaces)
  let write = false
  if (record) {
    layouts = record.layouts
    order = record.order
    tilingStore.setState({ pinned: record.pinned })
  } else {
    // First launch with workspaces: the window's layout becomes the one in front's.
    const window = windowLayout(from, tabs)
    const front = workspaceOfTab(activeTab(window.tabs))
    const moved = migrateWindowLayout(window.json, window.tabs, workspaceOfTab, front)
    tabs = moved.tabs
    const own = reconcileDock(moved.layout, tabs, (id) => titleOf(tabs, id))
    layouts = own ? { [front]: own } : {}
    order = [front]
    write = true
  }
  if (tabs !== tabsState.tabs) tabsStore.setState({ tabs })
  const ws = workspaceOfTab(activeTab(tabs))
  show(ws, layouts[ws] ?? null)
  if (write) saveNow()
  else lastSaved = savedText()
}

/** Puts workspace `ws` on the engine from `own` (its saved layout, or none yet). */
function show(ws: string, own: DockJson | null): void {
  if (!api) return
  const tabs = tabsStore.getState().tabs
  const json = composeWorkspace(own, {
    tabs,
    ws,
    wsOf: workspaceOfTab,
    everywhere,
    pinned: tilingStore.getState().pinned,
    box: box(),
    titles: (id) => titleOf(tabs, id) ?? id,
  })
  if (!json) return
  // Group ids count within a workspace (its panes are p1, p2...), not across them.
  groupSeq = 0
  syncing = true
  try {
    api.fromJSON(json as unknown as Parameters<DockviewApi['fromJSON']>[0])
  } finally {
    syncing = false
  }
  syncedActive = activeTab(tabs).id
  warm.add(ws)
  order = [ws, ...order.filter((w) => w !== ws)]
  tilingStore.setState({ loaded: true, scope: ws })
  refresh()
}

/** The workspace on screen's own layout, read from the engine. */
function currentOwn(): DockJson | null {
  const ws = tilingStore.getState().scope
  return api ? ownOf(ws, api.toJSON() as unknown as DockJson) : null
}

/**
 * Workspace `ws`'s own part of `json`: shown-everywhere tabs leave, and its tab that went on to
 * another workspace leaves a marker where it stood (shell-core HOME_VIEW).
 */
function ownOf(ws: string, json: DockJson): DockJson | null {
  const away = (id: string): boolean => {
    const n = appTabOf(id)
    const t = n === null ? undefined : tabsStore.getState().tabs.list.find((x) => x.id === n)
    return t !== undefined && !everywhere(t) && workspaceOfTab(t) !== ws
  }
  return ownLayout(json, (id) => isGlobalIn(ws, id), away)
}

/** A new chat's place (no session file yet). */
const isDraftPlace = (p: Place | undefined): boolean =>
  p !== undefined && p.page === 'chat' && (p.chat === null || p.chat === 'draft')

/**
 * Leaves the workspace on screen for `ws`: its layout is kept, `ws`'s comes back as it was. A
 * chat or page workspace left with nothing but its tab closes that tab (it reopens on return).
 */
function swapTo(ws: string): void {
  if (!api) return
  const from = tilingStore.getState().scope
  const own = currentOwn()
  if (from) {
    if (own) layouts[from] = own
    else delete layouts[from]
  }
  show(ws, layouts[ws] ?? null)
  if (from && from !== ws && own && isBareLayout(own) && !isAssistantWorkspace(from)) {
    // Nothing of its own but its tab: it closes (and reopens on return). An empty new chat too.
    const empty = from.startsWith('draft:') && draftText(from).trim() === ''
    if (from.startsWith('chat:') || from.startsWith('page:') || empty) dropWorkspaceTabs(from)
  }
  scheduleSave()
}

/** Closes workspace `ws`'s own (unpinned) tabs and forgets its layout. */
function dropWorkspaceTabs(ws: string): void {
  delete layouts[ws]
  const gone = tabsStore
    .getState()
    .tabs.list.filter((t) => !t.pinned && workspaceOfTab(t) === ws)
    .map((t) => t.id)
  if (gone.length) updateTabs((t) => gone.reduce((acc, id) => closeTabIn(acc, id), t))
}

/** The owner chain changed (the chat list or activity loaded): the tab in front may move. */
export function refreshWorkspaces(): void {
  if (!tilingStore.getState().loaded) return
  syncFromTabs()
}

// Snapshot ------------------------------------------------------------------------------------

function groupHasApp(g: DockviewGroupPanel): boolean {
  return g.panels.some((p) => appTabOf(p.id) !== null)
}

/** Reads the engine into the store, and marks each group's element for styling and tests. */
function refresh(): void {
  if (!api || !root || headless()) return
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
    const rect =
      b.width > 0
        ? { x: b.left - origin.left, y: b.top - origin.top, w: b.width, h: b.height }
        : laid[g.id]
    return {
      id: g.id,
      views: g.panels.map((p) => p.id),
      active: g.activePanel?.id ?? null,
      rect:
        hidden || !rect
          ? null
          : {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.w),
              h: Math.round(rect.h),
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
    // The strip's empty end: window chrome to drag the window by (the tab bar's spacer).
    const drag = header?.querySelector<HTMLElement>(':scope > .dv-void-container')
    if (drag) drag.dataset['testid'] = g.id === leadPane?.id ? 'tabbar-drag' : `pane-drag-${g.id}`
    const body = el.querySelector<HTMLElement>(':scope > .dv-content-container')
    if (body) body.dataset['testid'] = `pane-body-${g.id}`
    const minimumWidth = app ? MAIN_MIN : TILE_MIN_W
    if (g.minimumWidth !== minimumWidth) {
      g.api.setConstraints({ minimumWidth, minimumHeight: TILE_MIN_H })
    }
  }
  const prev = tilingStore.getState()
  const next = { panes, focus, zoom: maximized, lead: leadPane?.id ?? null, contentMin }
  if (
    JSON.stringify([prev.panes, prev.focus, prev.zoom, prev.lead, prev.contentMin]) !==
    JSON.stringify([next.panes, next.focus, next.zoom, next.lead, next.contentMin])
  ) {
    tilingStore.setState(next)
  }
  // A tab moved to another pane can land somewhere else at the same size: slots re-measure.
  window.dispatchEvent(new Event(LAYOUT_EVENT))
  scheduleSave()
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

/** The tool tab an open panel shows (on screen, or in a workspace not on screen). */
export function toolTabOfId(id: string): ToolTab | null {
  const panel = api?.getPanel(id)
  if (panel) return toolTabFromJson(panel.params?.['tab'])
  for (const json of Object.values(layouts)) {
    const raw = json.panels[id]
    if (raw) return toolTabFromJson(raw.params?.['tab'])
  }
  return null
}

/**
 * Every tool tab whose content stays mounted: those of the workspace on screen, the pinned ones,
 * and those of every workspace shown this session (their pages, files and terminals keep their
 * state while hidden).
 */
export function mountedToolTabs(): Map<string, ToolTab> {
  const out = new Map<string, ToolTab>()
  const s = tilingStore.getState()
  for (const pane of s.panes) {
    for (const id of pane.views) {
      const tab = appTabOf(id) === null ? toolTabOfId(id) : null
      if (tab) out.set(id, tab)
    }
  }
  for (const t of s.pinned) out.set(toolTabId(t), t)
  for (const ws of warm) {
    if (ws === s.scope) continue
    for (const raw of Object.values(layouts[ws]?.panels ?? {})) {
      const tab = toolTabFromJson(raw.params?.['tab'])
      if (tab && !out.has(raw.id)) out.set(raw.id, tab)
    }
  }
  return out
}

// Tabs store <-> dock ---------------------------------------------------------------------------

function onActivePanel(panel: IDockviewPanel | undefined): void {
  refresh()
  if (syncing || !panel || headless()) return
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
  const group = api?.groups.find(groupHasApp) ?? api?.activeGroup ?? api?.groups[0]
  return group ? { position: { referenceGroup: group } } : {}
}

/**
 * Puts the tabs store's tabs on the dock. The active tab in another workspace swaps the layout
 * (a draft that got its file keeps its own); else the workspace's new tabs open, closed ones go,
 * and the active one comes forward.
 */
function syncFromTabs(): void {
  const tabsState = tabsStore.getState()
  if (!api || !tilingStore.getState().loaded || syncing || headless()) return
  const { tabs } = tabsState
  const active = activeTab(tabs)
  const ws = workspaceOfTab(active)
  const front = tilingStore.getState().scope
  if (ws !== front) {
    // A new chat that got its file (its place replaced, no history step) keeps its panes; a tab
    // that navigated on from a new chat shows the target's own.
    const renamed = front === `draft:${active.id}` && !isDraftPlace(active.back.at(-1))
    if (renamed && !layouts[ws]) renameScope(front, ws)
    else if (pressed) {
      // A tab pressed in the panes (a shortcut clicked or dragged): the swap waits for the release.
      swapAfterPress = true
      return
    } else {
      hint = null
      quietActive = false
      swapTo(ws)
      return
    }
  }
  const dock = api
  const mine = workspaceTabs(tabs, ws, workspaceOfTab, everywhere)
  syncing = true
  try {
    for (const tab of mine) {
      if (dock.getPanel(appPanelId(tab.id))) continue
      const { position, share, front: inFront } = placeFor()
      const panel = dock.addPanel({
        ...appPanelOptions(tab),
        ...(position ? { position } : {}),
        inactive: tab.id !== active.id && !inFront,
      })
      if (share !== undefined) sizeShare(panel.group, share)
    }
    const live = new Set(mine.map((t) => appPanelId(t.id)))
    for (const panel of [...dock.panels]) {
      if (appTabOf(panel.id) !== null && !live.has(panel.id)) dock.removePanel(panel)
    }
    pinnedFirst(tabs)
    for (const tab of mine) {
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
  scheduleSave()
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
      const siblings = panel.group.panels.filter((p) => appTabOf(p.id) !== null)
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

/** A new chat: a draft, a workspace of its own. */
export function newChatTabIn(): void {
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

/** A chat or an assistant's thread: it opens as an app tab, a page beside one as a page tab. */
const isChatPlace = (p: Place): boolean => p.page === 'chat' || p.page.startsWith('agent:')

/** A page tab already open in the workspace on screen showing `place`. */
function openPageTab(place: Place): IDockviewPanel | undefined {
  return api?.panels.find((p) => {
    const tab = toolTabFromJson(p.params?.['tab'])
    return tab?.kind === 'page' && samePlace(pageTabPlace(tab), place)
  })
}

/** The pane right of the active app tab's, where things open beside it. */
function besidePane(): { right: DockviewGroupPanel | undefined; origin: DockviewGroupPanel | null } {
  // The chat's pane: the active app tab's on screen; a hidden workspace's first pane of app tabs.
  const origin =
    (syncedActive === null ? null : groupOf(appPanelId(syncedActive))) ??
    api?.groups.find(groupHasApp) ??
    api?.activeGroup ??
    null
  if (!origin) return { right: undefined, origin }
  const id = neighbor(rectsById(), origin.id, 'right')
  return { right: id ? groupById(id) : undefined, origin }
}

/**
 * Opens `place` beside the chat. A page opens as a page tab in the pane right of the chat (else
 * a new pane split off at the tool pane's share). A chat of this workspace (a session its
 * assistant owns) opens as a tab there too; another workspace's chat is never put beside this
 * one: it opens as its own workspace. A place already open comes forward.
 */
export function openPlaceBeside(place: Place): void {
  if (isChatPlace(place)) {
    if (workspaceOfPlace(place) !== tilingStore.getState().scope) {
      navigateTo(place)
      return
    }
    const open = tabsStore.getState().tabs.list.find((t) => samePlace(t.here, place))
    if (open) {
      showQuietly(appPanelId(open.id))
      return
    }
    const { right, origin } = besidePane()
    if (api && origin) {
      hint = right
        ? { position: { referenceGroup: right }, front: true }
        : {
            position: { referenceGroup: origin, direction: 'right' },
            share: TOOL_PANE_SHARE,
            front: true,
          }
    }
    updateTabs((t) => insertTab(t, place))
    return
  }
  const open = openPageTab(place)
  if (open) {
    showQuietly(open.id)
    return
  }
  const { right } = besidePane()
  openTab(pageTab(place), right?.id, !right)
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
  openPlaceInPane(place, group.id)
}

/** Shows `place` as a tab of `pane` (a pane's + menu): moved there when it is open elsewhere. */
export function openPlaceInPane(place: Place, pane: string): void {
  const group = paneOf(pane)
  if (!isChatPlace(place)) {
    const open = openPageTab(place)
    if (open) showQuietly(open.id, group)
    else openTab(pageTab(place), pane)
    return
  }
  if (workspaceOfPlace(place) !== tilingStore.getState().scope) {
    navigateTo(place)
    return
  }
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

/** A page tab now shows `place` (a board it switched to): its tab keeps its id. */
export function replacePageTab(id: string, place: Place): void {
  const panel = api?.getPanel(id)
  const tab = panel ? toolTabFromJson(panel.params?.['tab']) : null
  if (!panel || tab?.kind !== 'page') return
  const next: ToolTab = { ...tab, place: placeToJson(place) }
  panel.api.updateParameters({ tab: next })
  const title = paneTabTitle(next)
  if (panel.title !== title) panel.api.setTitle(title)
  bump()
  scheduleSave()
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
 * with no tool pane (or `split`), a new one opens right of the app tabs. Naming a pane moves an
 * open tab there. Answers the pane that holds it.
 */
export function openTab(tab: ToolTab, pane?: string, split = false): string {
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
    bump()
  } else {
    const into = target ?? (split ? null : preferredToolPane())
    const anchor =
      (syncedActive === null ? undefined : dock.getPanel(appPanelId(syncedActive))?.group) ??
      dock.groups.find(groupHasApp) ??
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

/** Closes panel `id`: an app tab through the tabs store, a tool tab here (a page with its tab). */
export function closeTab(id: string): void {
  const n = appTabOf(id)
  if (n !== null) {
    if (!tabsStore.getState().tabs.list.some((t) => t.id === n)) fail('not-found', `No tab ${id}`)
    closeAppTab(n)
    return
  }
  const panel = api?.getPanel(id)
  if (!api || !panel) fail('not-found', `No tab ${id}`)
  const tool = toolTabFromJson(panel.params?.['tab'])
  api.removePanel(panel)
  if (tilingStore.getState().pinned.some((t) => toolTabId(t) === id)) dropPin(id)
  if (tool?.kind === 'web') closeWebPage(tool.id)
}

/** A page tab's browser page closes with it (its panel is the only way to see it). */
function closeWebPage(tabId: string): void {
  void invoke('browser.closeTab', { tabId })
}

/** Moves panel `id` into `toPane` at `index` (default after the tab in front there). */
export function moveTab(id: string, toPane: string, index?: number): void {
  const panel = api?.getPanel(id)
  if (!panel) fail('not-found', `No tab ${id}`)
  const group = paneOf(toPane)
  if (!dropAllowed(id, group.id, 'tab')) {
    fail('not-allowed', `${id} is another workspace's tab; it stays in its strip`)
  }
  const front = group.activePanel
    ? group.panels.indexOf(group.activePanel) + 1
    : group.panels.length
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

// Pins ------------------------------------------------------------------------------------------

/**
 * Pins tool tab `id` to every workspace (or unpins it: it stays in the workspace on screen and
 * leaves the others).
 */
export function setPinned(id: string, on: boolean): void {
  const { pinned } = tilingStore.getState()
  const has = pinned.some((t) => toolTabId(t) === id)
  if (on === has) return
  const tab = on ? toolTabOfId(id) : pinned.find((t) => toolTabId(t) === id)
  if (!tab) fail('not-found', `No tab ${id}`)
  if (on) tilingStore.setState({ pinned: [...pinned, tab] })
  else dropPin(id)
  // A pinned page is everyone's in the browser too: its page shows in every workspace's scope.
  if (tab.kind === 'web') void invoke('browser.pinTab', { tabId: tab.id, pinned: on })
  bump()
  scheduleSave()
}

function dropPin(id: string): void {
  tilingStore.setState((s) => ({ pinned: s.pinned.filter((t) => toolTabId(t) !== id) }))
  bump()
  scheduleSave()
}

export const isPinnedTool = (s: TilingState, id: string): boolean =>
  s.pinned.some((t) => toolTabId(t) === id)

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
    if (!dropAllowed(item, undefined, 'content')) {
      fail('not-allowed', `${item} is another workspace's tab; workspaces never sit side by side`)
    }
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
 * Closes pane `id` and its tabs (app tabs close in the tabs store). The pane holding every one of
 * the workspace's own app tabs never closes.
 */
export function closePaneById(id: string): void {
  if (!api) fail('not-found', 'The panes are not ready')
  const group = paneOf(id)
  const apps = group.panels.map((p) => appTabOf(p.id)).filter((n) => n !== null)
  const ws = tilingStore.getState().scope
  const own = tabsStore
    .getState()
    .tabs.list.filter((t) => !t.pinned && workspaceOfTab(t) === ws)
    .map((t) => t.id)
  if (own.length > 0 && own.every((n) => apps.includes(n))) {
    fail('not-allowed', "The pane holding the workspace's chat cannot close")
  }
  for (const p of [...group.panels]) {
    if (appTabOf(p.id) !== null) continue
    const tool = toolTabFromJson(p.params?.['tab'])
    api.removePanel(p)
    if (tool?.kind === 'web' && !tilingStore.getState().pinned.some((t) => toolTabId(t) === p.id)) {
      closeWebPage(tool.id)
    }
  }
  const closing = apps.filter((n) => own.includes(n))
  for (const p of [...group.panels]) {
    const n = appTabOf(p.id)
    // A pinned tab here is everyone's: it moves to another pane rather than closing.
    if (n !== null && !closing.includes(n)) {
      const home = api.groups.find((g) => g !== group && groupHasApp(g))
      if (home) p.api.moveTo({ group: home })
    }
  }
  if (closing.length) {
    const gone = new Set(closing)
    quietActive = gone.has(activeTab(tabsStore.getState().tabs).id)
    updateTabs((t) => closing.reduce((acc, n) => closeTabIn(acc, n), t))
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

/** Each pane's rect: as laid out on screen, or from the saved sizes on a hidden engine. */
function rectsById(): Record<string, Rect> {
  if (headless() && api) return dockRects(api.toJSON() as unknown as DockJson)
  const out: Record<string, Rect> = {}
  for (const p of tilingStore.getState().panes) if (p.rect) out[p.id] = p.rect
  return out
}

/** Focuses the pane beside the focused one; null when there is none that way. */
export function focusNeighbor(side: Side): string | null {
  const focus = headless() ? (api?.activeGroup?.id ?? null) : tilingStore.getState().focus
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
 * shows them again, and with that pane alone opens the default tools (Files) right of it.
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
  const [first, ...rest] = TOOL_KINDS
  if (!first) return
  const pane = splitAt(home.id, 'right', { kind: first }, TOOL_PANE_SHARE)
  const target = pane === null ? undefined : groupById(pane)
  if (!target) return
  for (const kind of rest) {
    const panel = dock.getPanel(kind)
    if (panel && panel.group !== target) panel.api.moveTo({ group: target })
    else if (!panel) {
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
  dock.getPanel(first)?.api.setActive()
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

/** The panes as agents read them: the window's, or a hidden engine's from its saved sizes. */
export function paneSnapshot(): Pick<TilingState, 'panes' | 'focus' | 'zoom'> {
  if (!headless() || !api) {
    const { panes, focus, zoom } = tilingStore.getState()
    return { panes, focus, zoom }
  }
  const json = api.toJSON() as unknown as DockJson
  const rects = dockRects(json)
  const zoom = api.hasMaximizedGroup()
    ? (api.groups.find((g) => g.api.isMaximized())?.id ?? null)
    : null
  return {
    panes: dockGroups(json.grid.root).map((g) => ({
      id: g.id,
      views: [...g.views],
      active: g.activeView ?? null,
      rect: zoom !== null && zoom !== g.id ? null : (rects[g.id] ?? null),
      app: g.views.some((v) => appTabOf(v) !== null),
    })),
    focus: api.activeGroup?.id ?? null,
    zoom,
  }
}

// Workspaces not on screen ----------------------------------------------------------------------

/** The workspace on screen. */
export const frontWorkspace = (): string => tilingStore.getState().scope

/** The workspace a hidden engine holds inside inWorkspace. */
let hiddenWs: string | null = null

/** The workspace the engine holds now: a hidden one inside inWorkspace, else the one on screen. */
export const currentWorkspace = (): string => hiddenWs ?? tilingStore.getState().scope

/**
 * Runs `fn` against workspace `ws`'s panes: the window's when it is on screen, else a hidden
 * engine loaded from its saved layout and saved back after (nothing on screen changes). A
 * workspace with no tab yet gets its home tab (its thread, chat or page), not shown.
 */
export function inWorkspace<T>(ws: string, fn: () => T): T {
  if (!api || headless()) fail('not-found', 'The panes are not ready')
  if (ws === tilingStore.getState().scope) {
    const out = fn()
    scheduleSave()
    return out
  }
  const tabs = tabsStore.getState().tabs
  if (!tabs.list.some((t) => workspaceOfTab(t) === ws)) {
    const home = workspaceHome(ws)
    if (!home) fail('not-found', `No workspace ${ws}`)
    syncing = true
    try {
      updateTabs((t) => ({
        ...t,
        list: [...t.list, { id: t.nextId, here: home, back: [], forward: [], pinned: false }],
        nextId: t.nextId + 1,
      }))
    } finally {
      syncing = false
    }
  }
  const all = tabsStore.getState().tabs
  const size = box()
  const json = composeWorkspace(layouts[ws] ?? null, {
    tabs: all,
    ws,
    wsOf: workspaceOfTab,
    everywhere,
    pinned: tilingStore.getState().pinned,
    box: size,
    titles: (id) => titleOf(all, id),
  })
  if (!json) fail('not-found', `No workspace ${ws}`)
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${size.width}px;height:${size.height}px;visibility:hidden`
  document.body.appendChild(host)
  const part = () => ({ element: document.createElement('div'), init: () => {} })
  const engine = createDockview(host, {
    createComponent: part,
    createTabComponent: part,
    disableFloatingGroups: true,
    groupIdGenerator: nextGroupId,
  })
  engine.layout(size.width, size.height)
  engine.fromJSON(json as unknown as Parameters<DockviewApi['fromJSON']>[0])
  liveApi = api
  liveRoot = root
  api = engine
  root = host
  hiddenWs = ws
  const seq = groupSeq
  groupSeq = 0
  try {
    const out = fn()
    const own = ownOf(ws, engine.toJSON() as unknown as DockJson)
    if (own) layouts[ws] = own
    if (!order.includes(ws)) order = [...order, ws]
    return out
  } finally {
    api = liveApi
    root = liveRoot
    liveApi = null
    liveRoot = null
    hiddenWs = null
    groupSeq = seq
    engine.dispose()
    host.remove()
    bump()
    scheduleSave()
  }
}

function bump(): void {
  if (!headless()) tilingStore.setState((s) => ({ rev: s.rev + 1 }))
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

// Scopes ----------------------------------------------------------------------------------------

/** A draft chat got its session file: its workspace (layout and browser tabs) follows it. */
export function renameScope(from: string, to: string): void {
  if (from === to) return
  const layout = layouts[from]
  delete layouts[from]
  if (layout) layouts[to] = layout
  order = order.map((w) => (w === from ? to : w))
  if (warm.delete(from)) warm.add(to)
  if (tilingStore.getState().scope === from) tilingStore.setState({ scope: to })
}

// Page tabs (one web page each; tiling/web-tabs.ts decides where they go) ------------------------

/**
 * Adds tool tab `tab` (not open yet) to the panes the engine holds: into pane `at.pane` at
 * `at.index` (default: right after the tab in front there), or into a new pane split off pane
 * `at.split` toward `at.side`, at the tool pane's share. `front`: it comes to the front of its
 * pane and that pane takes the focus; else it waits behind the tab in front (alone in a new pane
 * it shows, without the focus). Answers its pane.
 */
export function addToolTab(
  tab: ToolTab,
  at: { pane: string; index?: number } | { split: string; side: Side },
  front = true,
): string {
  if (!api) fail('not-found', 'The panes are not ready')
  const dock = api
  const id = toolTabId(tab)
  if (dock.getPanel(id)) fail('invalid-params', `${id} is open already`)
  let position: AddPanelPositionOptions
  if ('pane' in at) {
    const group = paneOf(at.pane)
    const after = group.activePanel
      ? group.panels.indexOf(group.activePanel) + 1
      : group.panels.length
    const index = Math.min(Math.max(Math.trunc(at.index ?? after), 0), group.panels.length)
    position = { referenceGroup: group, index }
  } else {
    position = { referenceGroup: paneOf(at.split), direction: DIRECTION[at.side] }
  }
  const panel = dock.addPanel({
    id,
    component: TOOL_PANEL,
    tabComponent: TOOL_PANEL,
    title: paneTabTitle(tab),
    params: { tab },
    position,
    inactive: !front,
  })
  if (!('pane' in at)) sizeShare(panel.group, TOOL_PANE_SHARE)
  if (front) {
    if (zoomHides(panel.group)) dock.exitMaximizedGroup()
    panel.api.setActive()
  }
  refresh()
  return panel.group.id
}

/** The engine showing workspace `ws`: the hidden one inside inWorkspace, the window's, or none. */
function engineOf(ws: string): DockviewApi | null {
  if (hiddenWs === ws) return api
  return ws === tilingStore.getState().scope ? (liveApi ?? api) : null
}

/** Workspace `ws`'s own tool tabs (pinned ones left out), on screen or as last saved. */
export function workspaceToolTabs(ws: string): ToolTab[] {
  const engine = engineOf(ws)
  const raw = engine
    ? engine.panels.map((p) => [p.id, p.params?.['tab']] as const)
    : Object.values(layouts[ws]?.panels ?? {}).map((p) => [p.id, p.params?.['tab']] as const)
  const { pinned } = tilingStore.getState()
  const out: ToolTab[] = []
  for (const [id, json] of raw) {
    const tab = toolTabFromJson(json)
    if (tab && toolTabId(tab) === id && !pinned.some((t) => toolTabId(t) === id)) out.push(tab)
  }
  return out
}

/** The workspace whose panes hold panel `id`: the one on screen first, else a saved one. */
export function workspaceHolding(id: string): string | null {
  const front = tilingStore.getState().scope
  if ((liveApi ?? api)?.getPanel(id)) return front
  for (const [ws, json] of Object.entries(layouts)) {
    if (ws !== front && json.panels[id]) return ws
  }
  return null
}

/** Workspaces whose panes still hold the retired Browser panel, the one on screen first. */
export function legacyBrowserWorkspaces(): string[] {
  const front = tilingStore.getState().scope
  const out = api?.getPanel(LEGACY_BROWSER_PANEL) && !headless() ? [front] : []
  for (const [ws, json] of Object.entries(layouts)) {
    if (ws !== front && json.panels[LEGACY_BROWSER_PANEL]) out.push(ws)
  }
  return out
}

const webPanelOf = (id: string): string => toolTabId({ kind: 'web', id })

/**
 * Replaces the retired Browser panel of workspace `ws` with one page tab per page it showed
 * (`pages`, the browser scope's tabs in its order), where it stood; when the Browser was in
 * front of its pane, page `front` is. Pages pinned in the browser become pinned page tabs. With
 * no page the panel just goes.
 */
export function replaceLegacyBrowser(
  ws: string,
  pages: ReadonlyArray<{ id: string; pinned: boolean }>,
  front: string,
): void {
  const { pinned } = tilingStore.getState()
  const pins = pages
    .filter((p) => p.pinned && !pinned.some((t) => toolTabId(t) === webPanelOf(p.id)))
    .map((p): ToolTab => ({ kind: 'web', id: p.id }))
  const keep = pinned.filter((t) => t.kind !== 'browser')
  if (pins.length || keep.length !== pinned.length) {
    tilingStore.setState({ pinned: [...keep, ...pins] })
  }
  if (ws === tilingStore.getState().scope && api && !headless()) {
    const legacy = api.getPanel(LEGACY_BROWSER_PANEL)
    if (legacy) {
      const group = legacy.group
      const wasFront = group.activePanel === legacy
      let index = group.panels.indexOf(legacy)
      for (const page of pages) {
        const id = webPanelOf(page.id)
        if (api.getPanel(id)) continue
        const tab: ToolTab = { kind: 'web', id: page.id }
        api.addPanel({
          id,
          component: TOOL_PANEL,
          tabComponent: TOOL_PANEL,
          title: paneTabTitle(tab),
          params: { tab },
          position: { referenceGroup: group, index: ++index },
          inactive: true,
        })
      }
      api.removePanel(legacy)
      const shown = api.getPanel(webPanelOf(front))
      if (wasFront && shown && shown.group === group) {
        group.model.openPanel(shown, { skipSetGroupActive: true })
      }
      refresh()
    }
  } else if (layouts[ws]?.panels[LEGACY_BROWSER_PANEL]) {
    const json = JSON.parse(JSON.stringify(layouts[ws])) as DockJson
    const own = pages.filter((p) => !p.pinned).map((p) => p.id)
    for (const g of dockGroups(json.grid.root)) {
      const at = g.views.indexOf(LEGACY_BROWSER_PANEL)
      if (at < 0) continue
      const ids = own.map(webPanelOf).filter((id) => !json.panels[id])
      g.views.splice(at + 1, 0, ...ids)
      if (g.activeView === LEGACY_BROWSER_PANEL && ids.length) {
        g.activeView = own.includes(front) ? webPanelOf(front) : ids[0]
      }
      for (const id of ids) {
        const tab: ToolTab = { kind: 'web', id: id.slice('web:'.length) }
        json.panels[id] = toolPanelJson(tab, paneTabTitle(tab))
      }
    }
    const next = ownLayout(json, (id) => id === LEGACY_BROWSER_PANEL)
    if (next) layouts[ws] = next
    else delete layouts[ws]
  }
  bump()
  scheduleSave()
}

// Persistence ---------------------------------------------------------------------------------

const SAVE_DELAY = 250
let lastSaved = ''
let timer: number | undefined

function savedText(): string {
  const front = tilingStore.getState().scope
  const own = currentOwn()
  const all = { ...layouts }
  if (front) {
    if (own) all[front] = own
    else delete all[front]
  }
  return JSON.stringify({
    dock: api?.toJSON() ?? null,
    workspaces: saveWorkspaces({ front, pinned: tilingStore.getState().pinned, layouts: all, order }),
  })
}

function saveNow(): void {
  timer = undefined
  if (!api || headless() || !tilingStore.getState().loaded) return
  const text = savedText()
  if (text === lastSaved) return
  lastSaved = text
  const body = JSON.parse(text) as { dock: Record<string, unknown>; workspaces: Record<string, unknown> }
  void invoke('layout.save', body).then((r) => {
    if (!r.ok) {
      lastSaved = ''
      console.warn('layout.save (workspaces) failed', r.error)
    }
  })
}

function scheduleSave(): void {
  if (!tilingStore.getState().loaded || syncing || headless()) return
  clearTimeout(timer)
  timer = window.setTimeout(saveNow, SAVE_DELAY)
}

/** Writes a pending debounced layout save now (quit, pagehide). No-op when nothing is queued. */
export function flushSave(): void {
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
    registerAction('new-tab', () => newPageTab()),
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
  setFrontBareCheck(frontIsBare)
  return () => {
    offs.forEach((off) => off())
    unsubTabs()
    window.removeEventListener('pagehide', flushSave)
    setFrontBareCheck(() => false)
    flushSave()
  }
}

/**
 * The workspace on screen is a plain chat or page with just its one tab (its panes stay saved
 * for it), or an empty new chat: going to a workspace with no tab yet takes that tab along
 * (tabs-store navigateTo) instead of leaving tabs behind. Never an assistant's, never one with
 * unsent text.
 */
function frontIsBare(): boolean {
  const ws = tilingStore.getState().scope
  if (!api || headless() || !tilingStore.getState().loaded || isAssistantWorkspace(ws)) return false
  if (ws.startsWith('draft:') && draftText(ws).trim() !== '') return false
  const mine = tabsStore.getState().tabs.list.filter((t) => !t.pinned && workspaceOfTab(t) === ws)
  return mine.length === 1
}

/** Test seam. */
export function resetTilingForTests(): void {
  lastSaved = ''
  clearTimeout(timer)
  timer = undefined
  saved = null
  syncedActive = null
  syncing = false
  hint = null
  quietActive = false
  pressed = null
  swapAfterPress = false
  hiddenWs = null
  groupSeq = 0
  layouts = {}
  order = []
  warm.clear()
  liveApi = null
  liveRoot = null
  tilingStore.setState(initialState(), true)
}
