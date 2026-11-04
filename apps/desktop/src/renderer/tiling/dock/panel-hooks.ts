import { useSyncExternalStore } from 'react'
import type { DockviewPanelApi } from 'dockview-react'
import { useTiling } from '../tiling-store'

/**
 * The panel is the one in front of its pane, focused or not (dockview's own `isActive` is only
 * true in the focused pane, so a tool pane's front tab would look like the others).
 */
export function usePanelActive(api: DockviewPanelApi): boolean {
  return useTiling((s) => s.panes.some((p) => p.active === api.id))
}

/** The panel's content is on screen (in front of a pane that shows). */
export function usePanelVisible(api: DockviewPanelApi): boolean {
  return useSyncExternalStore(
    (cb) => {
      const a = api.onDidVisibilityChange(cb)
      const b = api.onDidActiveChange(cb)
      return () => {
        a.dispose()
        b.dispose()
      }
    },
    () => api.isVisible,
  )
}

/** The pane holding panel `id`, as the tiling store last read it. */
export function usePaneOf(id: string): string | null {
  return useTiling((s) => s.panes.find((p) => p.views.includes(id))?.id ?? null)
}
