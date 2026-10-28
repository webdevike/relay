import { useEffect } from 'react'
import { invoke } from '../ipc'
import { isDispatchFromGuest, registerPageChord } from '../hotkeys/router'
import { tabFocused, tabVisible } from '../tiling/tiling-store'
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
        // Its pane has the keyboard (or the page itself sent it).
        if (!tabFocused('browser') && !isDispatchFromGuest()) return false
        void invoke('browser.closeTab', { tabId: activeId })
        return 'consumed'
      }),
      registerPageChord('cmd+l', () => {
        if (!tabVisible('browser')) return false
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
