import { useEffect } from 'react'
import { invoke } from '../ipc'
import { isPanelFocused } from '../hotkeys/panel-focus'
import { isDispatchFromGuest, registerPageChord } from '../hotkeys/router'
import { layoutStore } from '../shell/layout-store'
import { browserStore } from './browser-store'

/** Another panel view (Files, a transcript) sits over the browser. */
const browserHidden = (): boolean => layoutStore.getState().panelView.kind !== 'browser'

function focusAddress(): void {
  const el = document.querySelector<HTMLInputElement>('[data-testid=address-input]')
  el?.focus()
  el?.select()
}

/** Browser page-scope chords. Registered into the single router; no listeners of its own (D-11). */
export function useBrowserHotkeys(): void {
  useEffect(() => {
    const offs = [
      registerPageChord('cmd+w', () => {
        const { tabs, activeId } = browserStore.getState()
        if (!activeId || tabs.length === 0) return false
        if (!isPanelFocused() && !isDispatchFromGuest()) return false
        if (browserHidden() && !isDispatchFromGuest()) return false
        void invoke('browser.closeTab', { tabId: activeId })
        return 'consumed'
      }),
      registerPageChord('cmd+l', () => {
        if (browserHidden()) return false
        focusAddress()
        return 'consumed'
      }),
      registerPageChord('cmd+alt+i', () => {
        const { activeId } = browserStore.getState()
        if (!activeId) return false
        void invoke('browser.openDevTools', { tabId: activeId })
        return 'consumed'
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])
}
