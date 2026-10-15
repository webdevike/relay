import { notifications } from '@mantine/notifications'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import {
  PANEL_DEFAULT,
  PANEL_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  fit,
} from '@evaos/shell-core'
import { invoke } from '../ipc'
import { registerAction } from '../hotkeys/router'

export type SidebarState = 'open' | 'hidden' | 'folded'
export type Edge = 'sidebar' | 'panel'

export interface LayoutState {
  windowWidth: number
  /** Saved widths (what layout.json holds). */
  sidebarWidth: number
  panelWidth: number
  /** Preferences, memory only (D-04). */
  sidebarWanted: boolean
  panelOpen: boolean
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
    panelOpen: true,
    loaded: false,
  }
  return { ...base, ...derive(base) }
}

export const layoutStore = createStore<LayoutState>(initial)

function patch(p: Partial<Base>): void {
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

export function togglePanel(open?: boolean): void {
  patch({ panelOpen: open ?? !layoutStore.getState().panelOpen })
}

/** In-memory only; never calls IPC (T-02-30). */
export function previewWidth(edge: Edge, px: number): void {
  if (!Number.isFinite(px)) return
  const s = layoutStore.getState()
  if (edge === 'sidebar') {
    const w = fit(s.windowWidth, clampSidebar(px), s.panelOpen ? s.panelWidth : undefined).sidebar
    if (w === 0) return
    patch({ sidebarWidth: w })
  } else {
    const w = fit(
      s.windowWidth,
      s.sidebarWanted ? s.sidebarWidth : undefined,
      Math.max(px, PANEL_MIN),
    ).panel
    if (w === 0) return
    patch({ panelWidth: w })
  }
}

function saveLayoutPatch(p: { sidebarWidth: number } | { panelWidth: number }): void {
  void invoke('layout.save', p).then((r) => {
    if (!r.ok) console.warn('layout.save failed', r.error)
  })
}

export function commitWidth(edge: Edge): void {
  const s = layoutStore.getState()
  if (edge === 'sidebar') {
    saveLayoutPatch({ sidebarWidth: Math.round(s.sidebarPx || s.sidebarWidth) })
  } else {
    saveLayoutPatch({ panelWidth: Math.round(s.panelPx || s.panelWidth) })
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

/** Test seam. */
export function resetLayoutStoreForTests(): void {
  resetToastShown = false
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
