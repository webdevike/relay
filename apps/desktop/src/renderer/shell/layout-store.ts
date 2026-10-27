import { notifications } from '@mantine/notifications'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  PANEL_CHOICES_MAX,
  PANEL_DEFAULT,
  PANEL_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  fit,
} from '@evaos/shell-core'
import type { InvokeInput } from '@evaos/contract'
import { invoke } from '../ipc'
import { registerAction } from '../hotkeys/router'

export type SidebarState = 'open' | 'hidden' | 'folded'
export type Edge = 'sidebar' | 'panel'
/**
 * What the panel shows: one of its tools (the browser, the files editor), or a transient view
 * over it (one subagent's transcript, one experiment arm's details).
 */
export type PanelView =
  | { kind: 'browser' }
  | { kind: 'files' }
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
export type SubagentView = Extract<PanelView, { kind: 'subagent' }>
export type ExperimentArmView = Extract<PanelView, { kind: 'experiment-arm' }>
export type PanelTool = 'browser' | 'files'
const BROWSER_VIEW: PanelView = { kind: 'browser' }
const FILES_VIEW: PanelView = { kind: 'files' }

export interface LayoutState {
  windowWidth: number
  /** Preferred widths persisted to layout.json, never overwritten by window fitting. */
  sidebarWidth: number
  panelWidth: number
  /** Preferences, memory only (D-04). */
  sidebarWanted: boolean
  /** Whether the panel shows in the current browser scope (rules in enterPanelScope). */
  panelOpen: boolean
  /** The browser scope in front: the session or page the active app tab shows. */
  panelScope: string
  panelView: PanelView
  loaded: boolean
  /** Derived through shell-core fit only (D-01). */
  sidebarPx: number
  panelPx: number
  state: SidebarState
}

type Base = Pick<
  LayoutState,
  'windowWidth' | 'sidebarWidth' | 'panelWidth' | 'sidebarWanted' | 'panelOpen' | 'loaded'
>

function derive(b: Base): Pick<LayoutState, 'sidebarPx' | 'panelPx' | 'state'> {
  const w = fit(
    b.windowWidth,
    b.sidebarWanted ? b.sidebarWidth : undefined,
    b.panelOpen ? b.panelWidth : undefined,
  )
  const state: SidebarState = !b.sidebarWanted ? 'hidden' : w.sidebar === 0 ? 'folded' : 'open'
  return { sidebarPx: w.sidebar, panelPx: w.panel, state }
}

function initial(): LayoutState {
  const base: Base = {
    windowWidth: typeof window === 'undefined' ? 1280 : window.innerWidth,
    sidebarWidth: SIDEBAR_DEFAULT,
    panelWidth: PANEL_DEFAULT,
    sidebarWanted: true,
    // Closed until the scope in front has tabs or Isaac opens it.
    panelOpen: false,
    loaded: false,
  }
  return { ...base, panelScope: '', panelView: BROWSER_VIEW, ...derive(base) }
}

export const layoutStore = createStore<LayoutState>(initial)

/**
 * Isaac's explicit open or close per browser scope, persisted to layout.json (panel_choices).
 * Insertion order is recency: setting a scope moves it to the end; the oldest fall off the cap.
 */
const panelChoice = new Map<string, boolean>()
/** Each scope's own (unpinned) browser tab ids, as last reported by the host. */
const ownTabs = new Map<string, readonly string[]>()
/** The scope in front has neither a choice nor known tabs yet; its first report decides. */
let panelPending = false
/** The tool Isaac picked last (persisted as panel_tool); scope changes and closed slides come back to it. */
let tool: PanelTool = 'browser'
/** Isaac picked a tool this run, so the one loaded from layout.json no longer applies. */
let toolPicked = false
const toolView = (): PanelView => (tool === 'files' ? FILES_VIEW : BROWSER_VIEW)

function setChoice(scope: string, open: boolean): void {
  panelChoice.delete(scope)
  panelChoice.set(scope, open)
  for (const old of panelChoice.keys()) {
    if (panelChoice.size <= PANEL_CHOICES_MAX) break
    panelChoice.delete(old)
  }
}

function patch(p: Partial<Base> & { panelScope?: string; panelView?: PanelView }): void {
  layoutStore.setState((s) => {
    const base: Base = { ...s, ...p }
    return { ...p, ...derive(base) }
  })
}

const clampSidebar = (n: number): number => Math.min(Math.max(n, SIDEBAR_MIN), SIDEBAR_MAX)

export function useLayout<T>(selector: (s: LayoutState) => T): T {
  return useStore(layoutStore, selector)
}

export function setWindowWidth(w: number): void {
  if (!Number.isFinite(w) || w === layoutStore.getState().windowWidth) return
  patch({ windowWidth: w })
}

export function toggleSidebar(on?: boolean): void {
  patch({ sidebarWanted: on ?? !layoutStore.getState().sidebarWanted })
}

/** Isaac's toggle, remembered for the scope in front. */
export function togglePanel(open?: boolean): void {
  const s = layoutStore.getState()
  const next = open ?? !s.panelOpen
  setChoice(s.panelScope, next)
  panelPending = false
  patch({ panelOpen: next })
  saveLayoutPatch({ panelChoices: { [s.panelScope]: next } })
}

/** Opens the panel on a subagent's transcript; the browser choice for the scope is untouched. */
export function openSubagentPanel(view: Omit<SubagentView, 'kind'>): void {
  panelPending = false
  patch({ panelOpen: true, panelView: { kind: 'subagent', ...view } })
}

/** Opens the panel on one experiment arm's measurements and cases (Test Bench). */
export function openExperimentArmPanel(view: Omit<ExperimentArmView, 'kind'>): void {
  panelPending = false
  patch({ panelOpen: true, panelView: { kind: 'experiment-arm', ...view } })
}

/** Shows a panel tool (the Browser / Files tabs, Cmd+P), opening the panel in this scope. */
export function showPanelTool(next: PanelTool): void {
  tool = next
  toolPicked = true
  const s = layoutStore.getState()
  setChoice(s.panelScope, true)
  panelPending = false
  patch({ panelOpen: true, panelView: toolView() })
  saveLayoutPatch({ panelChoices: { [s.panelScope]: true }, panelTool: next })
}

/** Back to the panel's tool from a transient view, e.g. once a closed panel finished sliding out. */
export function settlePanelView(): void {
  const kind = layoutStore.getState().panelView.kind
  if (kind !== 'browser' && kind !== 'files') patch({ panelView: toolView() })
}

/**
 * The browser scope in front changed. The panel follows Isaac's remembered choice there; a
 * scope he never toggled is open iff it has its own tabs (pinned ones alone never open it).
 * A scope this renderer has no report for yet stays closed until the host reports its tabs.
 */
export function enterPanelScope(scope: string): void {
  if (scope === layoutStore.getState().panelScope) return
  const choice = panelChoice.get(scope)
  const own = ownTabs.get(scope)
  panelPending = choice === undefined && own === undefined
  patch({
    panelScope: scope,
    panelOpen: choice ?? (own !== undefined && own.length > 0),
    panelView: toolView(),
  })
}

/** A tab opened in the scope in front (a link, the + button, a page's window.open). */
export function panelTabCreated(): void {
  const scope = layoutStore.getState().panelScope
  const reopened = panelChoice.get(scope) === false
  if (reopened) setChoice(scope, true)
  const toolChanged = tool !== 'browser'
  panelPending = false
  tool = 'browser'
  toolPicked = true
  patch({ panelOpen: true, panelView: BROWSER_VIEW })
  if (reopened || toolChanged) {
    saveLayoutPatch({
      ...(reopened ? { panelChoices: { [scope]: true } } : {}),
      ...(toolChanged ? { panelTool: 'browser' as const } : {}),
    })
  }
}

/**
 * The host's tabs for `scope`. Resolves a pending scope, and opens the panel when a tab
 * appeared in the scope in front. Losing tabs never closes it: the panel shows the empty state.
 */
export function reportScopeTabs(scope: string, own: readonly string[]): void {
  const before = ownTabs.get(scope)
  ownTabs.set(scope, own)
  if (scope !== layoutStore.getState().panelScope) return
  if (panelPending) {
    panelPending = false
    patch({ panelOpen: own.length > 0 })
  } else if (before && own.some((id) => !before.includes(id))) {
    panelTabCreated()
  }
}

/** A draft chat got its session file: its panel state moves to the chat's scope. */
export function renamePanelScope(from: string, to: string): void {
  const choice = panelChoice.get(from)
  const own = ownTabs.get(from)
  panelChoice.delete(from)
  ownTabs.delete(from)
  if (choice !== undefined) {
    setChoice(to, choice)
    saveLayoutPatch({ panelChoices: { [from]: null, [to]: choice } })
  }
  if (own !== undefined) ownTabs.set(to, own)
  if (layoutStore.getState().panelScope === from) patch({ panelScope: to })
}

/** In-memory only; never calls IPC (T-02-30). */
export function previewWidth(edge: Edge, px: number): void {
  if (!Number.isFinite(px)) return
  const s = layoutStore.getState()
  if (edge === 'sidebar') {
    const w = clampSidebar(px)
    if (fit(s.windowWidth, w, s.panelOpen ? s.panelWidth : undefined).sidebar === 0) return
    patch({ sidebarWidth: w })
  } else {
    patch({ panelWidth: Math.max(px, PANEL_MIN) })
  }
}

function saveLayoutPatch(p: InvokeInput<'layout.save'>): void {
  void invoke('layout.save', p).then((r) => {
    if (!r.ok) console.warn('layout.save failed', r.error)
  })
}

export function commitWidth(edge: Edge): void {
  const s = layoutStore.getState()
  if (edge === 'sidebar') {
    saveLayoutPatch({ sidebarWidth: Math.round(s.sidebarWidth) })
  } else {
    saveLayoutPatch({ panelWidth: Math.round(s.panelWidth) })
  }
}

export function resetWidth(edge: Edge): void {
  if (edge === 'sidebar') patch({ sidebarWidth: SIDEBAR_DEFAULT })
  else patch({ panelWidth: PANEL_DEFAULT })
  // Save the default itself so a narrow window does not persist a squeezed width.
  saveLayoutPatch(
    edge === 'sidebar' ? { sidebarWidth: SIDEBAR_DEFAULT } : { panelWidth: PANEL_DEFAULT },
  )
}

let resetToastShown = false

export async function loadLayout(): Promise<void> {
  try {
    const r = await invoke('layout.load', {})
    if (!r.ok) return
    applyPanelState(r.value.panelChoices, r.value.panelTool)
    patch({
      sidebarWidth: clampSidebar(r.value.sidebarWidth),
      panelWidth: Math.max(r.value.panelWidth, PANEL_MIN),
      loaded: true,
    })
    if (r.value.reset && !resetToastShown) {
      resetToastShown = true
      notifications.show({ message: 'Layout was reset to defaults.' })
    }
  } catch {
    // keep defaults silently
  }
}

/**
 * Seeds the saved panel choices and tool. Scopes may have been entered (and toggled) before
 * layout.json arrived: choices made this run win, and the scope in front follows its saved choice
 * unless a transient view (a subagent, an experiment arm) is showing.
 */
function applyPanelState(saved: Record<string, boolean>, savedTool: PanelTool): void {
  const thisRun = [...panelChoice]
  panelChoice.clear()
  for (const [scope, open] of Object.entries(saved)) setChoice(scope, open)
  for (const [scope, open] of thisRun) setChoice(scope, open)
  if (!toolPicked) tool = savedTool
  const s = layoutStore.getState()
  if (s.panelView.kind !== 'browser' && s.panelView.kind !== 'files') return
  const choice = panelChoice.get(s.panelScope)
  if (choice !== undefined) panelPending = false
  patch({ panelOpen: choice ?? s.panelOpen, panelView: toolView() })
}

/** Test seam. */
export function resetLayoutStoreForTests(): void {
  resetToastShown = false
  panelChoice.clear()
  ownTabs.clear()
  panelPending = false
  tool = 'browser'
  toolPicked = false
  layoutStore.setState(initial(), true)
}

export function registerLayoutActions(): () => void {
  const a = registerAction('toggle-sidebar', () => toggleSidebar())
  const b = registerAction('toggle-panel', () => togglePanel())
  return () => {
    a()
    b()
  }
}
