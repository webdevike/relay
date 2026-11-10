import { notifications } from '@mantine/notifications'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, fitSidebar } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { registerAction } from '../hotkeys/router'
import { applySavedLayout, tilingStore } from '../tiling/tiling-store'
import { applySidebarPrefs } from '../sidebar/sidebar-prefs'
import { applyUiPrefs, bindPref, parseBool } from '../ui-prefs'

export const FOLDED_LABEL =
  'Sidebar hidden to fit the window. Widen the window or close a pane to bring it back.'

export type SidebarState = 'open' | 'hidden' | 'folded'

/** The sidebar column. The panes beside it live in the tiling store. */
export interface LayoutState {
  windowWidth: number
  /** Preferred width persisted to layout.json, never overwritten by window fitting. */
  sidebarWidth: number
  /** Preference; the choice to hide the sidebar is saved in layout.json `ui` (ui-prefs.ts). */
  sidebarWanted: boolean
  /** The smallest width the panes on screen take (tiling-store contentMin). */
  contentMin: number
  loaded: boolean
  /** Derived through shell-core fitSidebar only (D-01). */
  sidebarPx: number
  state: SidebarState
}

type Base = Pick<
  LayoutState,
  'windowWidth' | 'sidebarWidth' | 'sidebarWanted' | 'contentMin' | 'loaded'
>

function derive(b: Base): Pick<LayoutState, 'sidebarPx' | 'state'> {
  const px = fitSidebar(b.windowWidth, b.sidebarWanted ? b.sidebarWidth : undefined, b.contentMin)
  const state: SidebarState = !b.sidebarWanted ? 'hidden' : px === 0 ? 'folded' : 'open'
  return { sidebarPx: px, state }
}

function initial(): LayoutState {
  const base: Base = {
    windowWidth: typeof window === 'undefined' ? 1280 : window.innerWidth,
    sidebarWidth: SIDEBAR_DEFAULT,
    sidebarWanted: true,
    contentMin: tilingStore.getState().contentMin,
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

bindPref(layoutStore, 'shell.sidebarOpen', {
  select: (s) => s.sidebarWanted,
  apply: (sidebarWanted) => ({
    sidebarWanted,
    ...derive({ ...layoutStore.getState(), sidebarWanted }),
  }),
  parse: parseBool,
})

// The sidebar folds when the panes on screen need its room.
tilingStore.subscribe((s, prev) => {
  if (s.contentMin === prev.contentMin) return
  if (s.contentMin !== layoutStore.getState().contentMin) patch({ contentMin: s.contentMin })
})

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

/** In-memory only; never calls IPC (T-02-30). A width that would fold the sidebar is ignored. */
export function previewSidebarWidth(px: number): void {
  if (!Number.isFinite(px)) return
  const s = layoutStore.getState()
  const w = clampSidebar(px)
  if (fitSidebar(s.windowWidth, w, s.contentMin) === 0) return
  patch({ sidebarWidth: w })
}

function saveSidebarWidth(px: number): void {
  void invoke('layout.save', { sidebarWidth: px }).then((r) => {
    if (!r.ok) console.warn('layout.save failed', r.error)
  })
}

export function commitSidebarWidth(): void {
  saveSidebarWidth(Math.round(layoutStore.getState().sidebarWidth))
}

export function resetSidebarWidth(): void {
  patch({ sidebarWidth: SIDEBAR_DEFAULT })
  // Save the default itself so a narrow window does not persist a squeezed width.
  saveSidebarWidth(SIDEBAR_DEFAULT)
}

let resetToastShown = false

/** Loads the sidebar width and the pane layout from layout.json; the defaults stand on failure. */
export async function loadLayout(): Promise<void> {
  try {
    const r = await invoke('layout.load', {})
    if (r.ok) {
      const sidebarWidth = clampSidebar(r.value.sidebarWidth)
      applySavedLayout({
        dock: r.value.dock,
        workspaces: r.value.workspaces,
        tiling: r.value.tiling,
        legacy: r.value.legacyPanel,
        sidebarWidth,
      })
      patch({ sidebarWidth, loaded: true })
      applySidebarPrefs(r.value.sidebar)
      applyUiPrefs(r.value.ui)
      if (r.value.reset && !resetToastShown) {
        resetToastShown = true
        notifications.show({ message: 'Layout was reset to defaults.' })
      }
      return
    }
  } catch {
    // keep defaults silently
  }
  applySavedLayout({ dock: null, tiling: null, legacy: null, sidebarWidth: SIDEBAR_DEFAULT })
  applyUiPrefs(null)
}

/** Test seam. */
export function resetLayoutStoreForTests(): void {
  resetToastShown = false
  layoutStore.setState(initial(), true)
}

export function registerLayoutActions(): () => void {
  return registerAction('toggle-sidebar', () => toggleSidebar())
}
