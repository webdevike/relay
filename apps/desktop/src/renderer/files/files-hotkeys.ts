import { useEffect } from 'react'
import { registerPageChord } from '../hotkeys/router'
import { revealTool, tabFocused, tabVisible } from '../tiling/tiling-store'
import {
  currentSpace,
  filesStore,
  focusSearch,
  requestCloseTab,
  setQuickOpen,
  showSide,
} from './files-store'

/**
 * Files chords, registered while the app runs: Cmd+P (go to file) and Cmd+Shift+F (search in
 * files) bring the Files tab forward from anywhere; Cmd+Shift+E shows the explorer and Cmd+W
 * closes the active file while the Files pane has the keyboard.
 */
export function useFilesHotkeys(): void {
  useEffect(() => {
    const offs = [
      registerPageChord('cmd+p', () => {
        if (!tabVisible('files')) revealTool('files')
        setQuickOpen(true)
        return 'consumed'
      }),
      registerPageChord('cmd+shift+f', () => {
        if (!tabVisible('files')) revealTool('files')
        showSide('search')
        focusSearch()
        return 'consumed'
      }),
      registerPageChord('cmd+shift+e', () => {
        if (!tabVisible('files')) revealTool('files')
        showSide('explorer')
        queueMicrotask(() =>
          document.querySelector<HTMLElement>('[data-testid=files-tree]')?.focus(),
        )
        return 'consumed'
      }),
      registerPageChord('cmd+w', () => {
        if (!tabFocused('files')) return false
        const w = currentSpace(filesStore.getState())
        if (!w?.active) return false
        requestCloseTab(w.root, w.active)
        return 'consumed'
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])
}
