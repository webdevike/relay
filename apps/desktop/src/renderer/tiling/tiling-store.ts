import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  CHAT_PANE,
  GAP,
  MAIN_MIN,
  TOOL_KINDS,
  TOOL_PANE_SHARE,
  TilingError,
  activatePaneTab,
  allPanes,
  closePane,
  closePaneTab,
  defaultTiling,
  findNode,
  findPane,
  findTab,
  focusPane,
  isChatPane,
  isTabVisible,
  minSize,
  movePaneTab,
  neighbor,
  openPaneTab,
  parentOf,
  preferredToolPane,
  replacePaneTab,
  resizePane,
  setSplitSizes,
  setZoom,
  splitPane,
  tilingFromJson,
  tilingToJson,
  toolsShown,
  type ExperimentArmTab,
  type LegacyPanel,
  type PaneTab,
  type Rect,
  type Side,
  type SubagentTab,
  type Tiling,
  type ToolKind,
} from '@evaos/shell-core'
import { invoke } from '../ipc'
import { registerAction } from '../hotkeys/router'
import { focusedPane } from '../hotkeys/pane-focus'

/**
 * The window's pane tree (shell-core tiling.ts) and what the tool tabs follow. Every layout change
 * goes through here: Isaac's drags and shortcuts, the app's own reveals (a link opens the browser)
 * and agent actions. The tree persists to layout.json (`tiling`) a moment after each change.
 */
export interface TilingState {
  tiling: Tiling
  /** The saved tree arrived (or the old panel was migrated). */
  loaded: boolean
  /** The browser scope in front: what the active app tab shows. Tool tabs show this scope. */
  scope: string
  /** Each pane's px rect inside the tiling area, as last laid out. */
  rects: Record<string, Rect>
}

export const tilingStore = createStore<TilingState>(() => ({
  tiling: defaultTiling(),
  loaded: false,
  scope: '',
  rects: {},
}))

export function useTiling<T>(selector: (s: TilingState) => T): T {
  return useStore(tilingStore, selector)
}

/** Applies a tree operation; TilingError surfaces to the caller. Returns the new tree. */
export function updateTiling(fn: (t: Tiling) => Tiling): Tiling {
  const before = tilingStore.getState().tiling
  const next = fn(before)
  if (next !== before) tilingStore.setState({ tiling: next })
  return next
}

// Tabs ----------------------------------------------------------------------------------------

/** Shows a tool tab (see shell-core openPaneTab). Answers the pane that holds it. */
export function openTab(tab: PaneTab, pane?: string): string {
  const t = updateTiling((t) => openPaneTab(t, tab, pane))
  return t.focus
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

/** Swaps tab `id` for `tab` where it is (shell-core replacePaneTab). */
export function replaceTab(id: string, tab: PaneTab): void {
  updateTiling((t) => replacePaneTab(t, id, tab))
}

export function activateTab(id: string): void {
  updateTiling((t) => activatePaneTab(t, id))
}

export function closeTab(id: string): void {
  updateTiling((t) => closePaneTab(t, id))
}

export function moveTab(id: string, toPane: string, index?: number): void {
  updateTiling((t) => {
    const hit = findTab(t, id)
    if (!hit) throw new TilingError('not-found', `No tab ${id}`)
    return movePaneTab(t, hit.tab, toPane, index)
  })
}

/** Tab `id` is in front of a pane on screen. */
export function tabVisible(id: string): boolean {
  return isTabVisible(tilingStore.getState().tiling, id)
}

/** Tab `id` is in front of the pane that has the keyboard focus. */
export function tabFocused(id: string): boolean {
  const pane = focusedPane()
  const hit = findTab(tilingStore.getState().tiling, id)
  return pane !== null && hit !== null && hit.pane.id === pane && hit.pane.active === id
}

// Panes ---------------------------------------------------------------------------------------

/**
 * What a split without a named tab moves over: the pane's tab in front when it has others,
 * else the first tool not open yet; from the chat pane, the tab in front of a tool pane that has
 * others (the focused or last one first).
 */
export function defaultSplitTab(t: Tiling, paneId: string): PaneTab | null {
  const ofPane = (id: string | undefined): PaneTab | null => {
    const pane = id === undefined ? null : findPane(t, id)
    if (!pane || pane.tabs.length < 2 || pane.active === null) return null
    return findTab(t, pane.active)?.tab ?? null
  }
  if (!isChatPane(paneId)) {
    const own = ofPane(paneId)
    if (own) return own
  }
  const missing = TOOL_KINDS.find((kind) => !findTab(t, kind))
  if (missing) return { kind: missing }
  if (!isChatPane(paneId)) return null
  const preferred = preferredToolPane(t)
  const tools = allPanes(t.root).filter((p) => !isChatPane(p.id) && p !== preferred)
  for (const p of preferred ? [preferred, ...tools] : tools) {
    const tab = ofPane(p.id)
    if (tab) return tab
  }
  return null
}

/** Splits `paneId` toward `side`; answers the new pane, or null when there was nothing to move. */
export function splitAt(paneId: string, side: Side, tab?: PaneTab, share?: number): string | null {
  const t = tilingStore.getState().tiling
  if (!findNode(t.root, paneId)) throw new TilingError('not-found', `No pane ${paneId}`)
  const what = tab ?? defaultSplitTab(t, paneId)
  if (!what) return null
  const r = splitPane(t, paneId, side, what, share)
  tilingStore.setState({ tiling: r.tiling })
  return r.pane
}

export function closePaneById(id: string): void {
  updateTiling((t) => closePane(t, id))
}

export function focusPaneById(id: string): void {
  updateTiling((t) => focusPane(t, id))
}

/** Focuses the pane beside the focused one; null when there is none that way. */
export function focusNeighbor(side: Side): string | null {
  const { tiling, rects } = tilingStore.getState()
  const id = neighbor(rects, tiling.focus, side)
  if (id) focusPaneById(id)
  return id
}

/** Maximizes `paneId` (on), shows every pane (off), or toggles. */
export function zoomPane(paneId: string, on?: boolean): void {
  updateTiling((t) => {
    if (!findPane(t, paneId)) throw new TilingError('not-found', `No pane ${paneId}`)
    const want = on ?? t.zoom !== paneId
    return setZoom(t, want ? paneId : null)
  })
}

/**
 * The panel toggle (Cmd+Shift+B): hides the tool panes by zooming the chat pane, shows them again,
 * and with no tool pane left opens today's (Browser, Files) right of the chat.
 */
export function toggleToolPanes(open?: boolean): void {
  updateTiling((t) => {
    const shown = toolsShown(t)
    const want = open ?? !shown
    if (want === shown) return t
    if (!want) return setZoom(t, CHAT_PANE)
    if (allPanes(t.root).some((p) => !isChatPane(p.id))) return setZoom(t, null)
    const { tiling, pane } = splitPane(t, CHAT_PANE, 'right', { kind: 'browser' }, TOOL_PANE_SHARE)
    const filled = TOOL_KINDS.slice(1).reduce(
      (acc, kind) => movePaneTab(acc, { kind }, pane),
      tiling,
    )
    return activatePaneTab(filled, 'browser')
  })
}

/** Divider drags and keyboard nudges: new shares for a split's children. */
export function setSizes(splitId: string, sizes: readonly number[]): void {
  updateTiling((t) => setSplitSizes(t, splitId, sizes))
}

/** A node's px length along its parent split, from the laid-out pane rects. */
function lengthAlong(rects: Record<string, Rect>, t: Tiling, nodeId: string, row: boolean): number {
  const node = findNode(t.root, nodeId)
  if (!node) return 0
  const boxes = allPanes(node)
    .map((p) => rects[p.id])
    .filter((r): r is Rect => r !== undefined)
  if (boxes.length === 0) return 0
  const start = Math.min(...boxes.map((r) => (row ? r.x : r.y)))
  const end = Math.max(...boxes.map((r) => (row ? r.x + r.w : r.y + r.h)))
  return end - start
}

/**
 * Sets a pane's (or split's) share of its parent, as a share or px along the split, held so every
 * sibling keeps its minimum size.
 */
export function resizeNode(id: string, size: { share: number } | { px: number }): void {
  const { tiling: t, rects } = tilingStore.getState()
  const parent = parentOf(t.root, id)
  if (!findNode(t.root, id)) throw new TilingError('not-found', `No pane ${id}`)
  if (!parent) throw new TilingError('not-allowed', `Pane ${id} fills the window`)
  const row = parent.split.dir === 'row'
  const axis = row ? 'w' : 'h'
  const n = parent.split.children.length
  const free = lengthAlong(rects, t, parent.split.id, row) - GAP * (n - 1)
  let share = 'share' in size ? size.share : free > 0 ? size.px / free : 0.5
  if (free > 0) {
    const mins = parent.split.children.map((c) => minSize(c, axis, GAP) / free)
    const own = mins[parent.index] ?? 0
    const others = mins.reduce((a, b, i) => (i === parent.index ? a : a + b), 0)
    if (own + others <= 1) share = Math.min(Math.max(share, own), 1 - others)
  }
  updateTiling((tt) => resizePane(tt, id, share))
}

// Keyboard (pane shortcuts move the keyboard focus with the pane focus) -----------------------

function focusDom(paneId: string): void {
  requestAnimationFrame(() => {
    const frame = document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(paneId)}"]`)
    if (!frame || frame.contains(document.activeElement)) return
    const target =
      (isChatPane(paneId)
        ? frame.querySelector<HTMLElement>('[data-testid=composer-input]')
        : null) ?? frame
    target.focus({ preventScroll: true })
  })
}

function splitFocused(side: Side): void {
  const pane = splitAt(tilingStore.getState().tiling.focus, side)
  if (pane) focusDom(pane)
}

function focusToward(side: Side): void {
  const pane = focusNeighbor(side)
  if (pane) focusDom(pane)
}

function closeFocused(): void {
  const { focus } = tilingStore.getState().tiling
  if (isChatPane(focus)) return
  closePaneById(focus)
  focusDom(tilingStore.getState().tiling.focus)
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
  if (before && own.some((id) => !before.includes(id))) revealTool('browser')
}

// Layout px (sidebar fitting) -----------------------------------------------------------------

/** The smallest width the panes on screen can take, gaps included. */
export function contentMinWidth(t: Tiling): number {
  const zoomed = t.zoom === null ? null : findNode(t.root, t.zoom)
  return zoomed ? minSize(zoomed, 'w', GAP) : minSize(t.root, 'w', GAP)
}

export function setRects(rects: Record<string, Rect>): void {
  const prev = tilingStore.getState().rects
  const same =
    Object.keys(prev).length === Object.keys(rects).length &&
    Object.entries(rects).every(([id, r]) => {
      const p = prev[id]
      return p !== undefined && p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h
    })
  if (!same) tilingStore.setState({ rects })
}

// Persistence ---------------------------------------------------------------------------------

const SAVE_DELAY = 250
let lastSaved = ''
let timer: number | undefined

function save(): void {
  timer = undefined
  const json = tilingToJson(tilingStore.getState().tiling)
  const text = JSON.stringify(json)
  if (text === lastSaved) return
  lastSaved = text
  void invoke('layout.save', { tiling: json }).then((r) => {
    if (!r.ok) {
      lastSaved = ''
      console.warn('layout.save (tiling) failed', r.error)
    }
  })
}

function flushSave(): void {
  if (!timer) return
  clearTimeout(timer)
  save()
}

/**
 * Puts the saved tree in place. Without one, the old side panel becomes the first tool pane:
 * its width as the pane's share, its tool in front. That first tree is saved at once, which also
 * drops the panel's per-page choices from layout.json.
 */
export function applySavedTiling(
  saved: unknown,
  legacy: LegacyPanel | null,
  sidebarWidth: number,
): void {
  let tiling = tilingFromJson(saved)
  if (tiling) {
    lastSaved = JSON.stringify(tilingToJson(tiling))
  } else {
    const room = window.innerWidth - sidebarWidth - 3 * GAP
    const share = legacy ? legacy.width / Math.max(room, legacy.width + MAIN_MIN) : TOOL_PANE_SHARE
    tiling = defaultTiling(share, legacy?.tool ?? 'browser')
  }
  tilingStore.setState({ tiling, loaded: true })
  if (!lastSaved) save()
}

/** Pane shortcuts and persistence. Returns the unsubscribe. */
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
    registerAction('zoom-pane', () => zoomPane(tilingStore.getState().tiling.focus)),
  ]
  const unsub = tilingStore.subscribe((s, prev) => {
    if (!s.loaded || s.tiling === prev.tiling) return
    clearTimeout(timer)
    timer = window.setTimeout(save, SAVE_DELAY)
  })
  window.addEventListener('pagehide', flushSave)
  return () => {
    offs.forEach((off) => off())
    unsub()
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
  tilingStore.setState({ tiling: defaultTiling(), loaded: false, scope: '', rects: {} }, true)
}
