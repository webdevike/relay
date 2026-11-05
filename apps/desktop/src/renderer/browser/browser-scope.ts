import { invoke } from '../ipc'
import { renameScope, tilingStore } from '../tiling/tiling-store'
import { browserStore } from './browser-store'

let current = ''

/**
 * Keeps the browser host's scope on the workspace on screen (its key is the scope), once the
 * panes are built. Returns the unsubscribe.
 */
export function startBrowserScope(): () => void {
  const sync = (): void => {
    const { loaded, scope } = tilingStore.getState()
    if (!loaded || !scope || scope === current) return
    current = scope
    void invoke('browser.setScope', { scope }).then((r) => {
      if (r.ok) browserStore.getState().set(r.value)
    })
  }
  sync()
  const off = tilingStore.subscribe(sync)
  return () => {
    off()
    current = ''
  }
}

/** A draft chat got its session file: its workspace and browser tabs carry over. */
export function renameBrowserScope(from: string, to: string): void {
  if (from === to) return
  if (current === from) current = to
  renameScope(from, to)
  void invoke('browser.renameScope', { from, to })
}
