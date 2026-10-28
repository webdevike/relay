import { browserScope } from '@evaos/shell-core'
import { invoke } from '../ipc'
import { enterScope, renameScope } from '../tiling/tiling-store'
import { activePlace, activeTabId, tabsStore } from '../tabs/tabs-store'
import { browserStore } from './browser-store'

let current = ''

/**
 * Keeps the browser host's scope (and the tool tabs) on what the active app tab shows, once the
 * saved tabs are loaded. Returns the unsubscribe.
 */
export function startBrowserScope(): () => void {
  const sync = (): void => {
    const s = tabsStore.getState()
    if (!s.loaded) return
    const scope = browserScope(activePlace(s), activeTabId(s))
    if (scope === current) return
    current = scope
    enterScope(scope)
    void invoke('browser.setScope', { scope }).then((r) => {
      if (r.ok) browserStore.getState().set(r.value)
    })
  }
  sync()
  const off = tabsStore.subscribe(sync)
  return () => {
    off()
    current = ''
  }
}

/** A draft chat got its session file: its browser tabs carry over. */
export function renameBrowserScope(from: string, to: string): void {
  if (from === to) return
  if (current === from) current = to
  renameScope(from, to)
  void invoke('browser.renameScope', { from, to })
}
