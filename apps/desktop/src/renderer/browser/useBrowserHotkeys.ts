import { useEffect } from 'react'
import { invoke } from '../ipc'
import { isDispatchFromGuest, registerPageChord } from '../hotkeys/router'
import { focusedPane } from '../hotkeys/pane-focus'
import { closeTab, tabVisible, tilingStore } from '../tiling/tiling-store'
import { webPanelId, webTabOf } from '../tiling/web-tabs'
import { browserStore, focusAddressOf } from './browser-store'

/**
 * The page a page chord acts on: the one that sent it (the host's active page), else the page tab
 * in front of the pane with the keyboard focus. With `onScreen`, also the host's active page when
 * its tab shows.
 */
function targetPage(onScreen = false): string | null {
  const { activeId } = browserStore.getState()
  if (isDispatchFromGuest()) return activeId || null
  // DOM focus only: with the keyboard elsewhere (the tab bar, the sidebar) Cmd+W closes the app tab.
  const pane = focusedPane()
  const front = webTabOf(tilingStore.getState().panes.find((p) => p.id === pane)?.active)
  if (front) return front
  return onScreen && activeId && tabVisible(webPanelId(activeId)) ? activeId : null
}

/** Browser page-scope chords. Registered into the single router; no listeners of its own (D-11). */
export function useBrowserHotkeys(): void {
  useEffect(() => {
    const offs = [
      registerPageChord('cmd+w', () => {
        const page = targetPage()
        if (!page) return false
        // Its tab closes with it; a page with no tab closes alone.
        try {
          closeTab(webPanelId(page))
        } catch {
          void invoke('browser.closeTab', { tabId: page })
        }
        return 'consumed'
      }),
      registerPageChord('cmd+l', () => {
        const page = targetPage(true)
        if (!page) return false
        focusAddressOf(page)
        return 'consumed'
      }),
      registerPageChord('cmd+alt+i', () => {
        const page = targetPage(true)
        if (!page) return false
        void invoke('browser.openDevTools', { tabId: page })
        return 'consumed'
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])
}
