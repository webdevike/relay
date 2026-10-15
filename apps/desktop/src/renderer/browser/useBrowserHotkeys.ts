import { useEffect } from 'react'
import { matchesAppChord, type AppChord } from '@evaos/browser-core/hotkeys'
import { invoke, on } from '../ipc'
import { browserStore } from './browser-store'

function focusAddress(): void {
  const el = document.querySelector<HTMLInputElement>('[data-testid=address-input]')
  el?.focus()
  el?.select()
}

function run(chord: AppChord): void {
  const { tabs, activeId } = browserStore.getState()
  const idx = tabs.findIndex((t) => t.id === activeId)
  switch (chord) {
    case 'new-tab':
      void invoke('browser.createTab', {})
      break
    case 'close-tab':
      if (activeId) void invoke('browser.closeTab', { tabId: activeId })
      break
    case 'focus-address':
      focusAddress()
      break
    case 'prev-tab':
    case 'next-tab': {
      if (tabs.length < 2) break
      const n = tabs.length
      const to = tabs[(idx + (chord === 'next-tab' ? 1 : n - 1)) % n]
      if (to) void invoke('browser.activateTab', { tabId: to.id })
      break
    }
    case 'devtools':
      if (activeId) void invoke('browser.openDevTools', { tabId: activeId })
      break
    default:
      break
  }
  // The Phase 2 hotkey router listens for this.
  window.dispatchEvent(new CustomEvent('eva:hotkey', { detail: chord }))
}

/** Chords from guest pages (forwarded by main) and from the shell itself. */
export function useBrowserHotkeys(): void {
  useEffect(() => {
    const off = on('browser.hotkey', (p) => run(p.chord))
    const onKey = (e: KeyboardEvent): void => {
      const chord = matchesAppChord({
        type: 'keyDown',
        key: e.key,
        meta: e.metaKey,
        control: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        isAutoRepeat: e.repeat,
      })
      if (!chord) return
      e.preventDefault()
      run(chord)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      off()
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}
