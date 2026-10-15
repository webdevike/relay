import { useEffect } from 'react'
import { invoke } from '../ipc'
import { isPanelFocused } from '../hotkeys/panel-focus'
import { isDispatchFromGuest, registerPageChord } from '../hotkeys/router'
import { browserStore } from './browser-store'

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
        void invoke('browser.closeTab', { tabId: activeId })
        return 'consumed'
      }),
      registerPageChord('cmd+l', () => {
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
