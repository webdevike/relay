import { useEffect, useRef } from 'react'
import { isMod } from '@evaos/shell-core'
import { registerOverlayChord } from '../../hotkeys/router'
import { copyImage, saveMedia, type MediaTarget } from './media-actions'

/** Text Isaac is typing or has selected keeps Cmd+C for itself. */
function copyBelongsToText(): boolean {
  const el = document.activeElement
  if (el instanceof HTMLElement) {
    if (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  }
  const sel = window.getSelection()
  return sel !== null && !sel.isCollapsed
}

/**
 * While a full-screen viewer shows `target`: Cmd+S saves it (an overlay chord, so it beats the
 * page's and the terminal's) and Cmd+C copies an image. Cmd+C is a native edit chord the hotkey
 * router never takes, so a keydown here claims it only when no text owns it.
 */
export function useViewerMediaKeys(target: MediaTarget | null, active: boolean): void {
  const current = useRef(target)
  current.current = target
  useEffect(() => {
    if (!active) return
    const offSave = registerOverlayChord('cmd+s', () => {
      const t = current.current
      if (t !== null) void saveMedia(t)
      // Consumed either way: the viewer covers whatever else Cmd+S would save.
      return 'consumed'
    })
    const onKey = (e: KeyboardEvent): void => {
      const t = current.current
      if (t?.kind !== 'image' || e.repeat || !isMod(e) || e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() !== 'c' || copyBelongsToText()) return
      e.preventDefault()
      void copyImage(t)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      offSave()
      document.removeEventListener('keydown', onKey)
    }
  }, [active])
}
