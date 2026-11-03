import { createDockview } from 'dockview-react'
import { applySavedLayout, attachDock, nextGroupId } from './tiling-store'

/**
 * Test seam: a real dockview engine with empty panel parts, attached to the tiling store and,
 * unless `apply` is false (a test loads its own), given `dock` (or the default panes) once the
 * tabs store has loaded. Returns the teardown.
 */
export function mountTestDock(dock: unknown = null, apply = true): () => void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const api = createDockview(host, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
    disableFloatingGroups: true,
    groupIdGenerator: nextGroupId,
  })
  api.layout(1200, 800)
  const detach = attachDock(api, host)
  if (apply) applySavedLayout({ dock, tiling: null, legacy: null, sidebarWidth: 272 })
  return () => {
    detach()
    api.dispose()
    host.remove()
  }
}
