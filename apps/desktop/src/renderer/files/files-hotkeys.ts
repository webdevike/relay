import { useEffect } from 'react'
import { isPanelFocused } from '../hotkeys/panel-focus'
import { registerPageChord } from '../hotkeys/router'
import { layoutStore, showPanelTool } from '../shell/layout-store'
import {
  currentSpace,
  filesStore,
  focusSearch,
  requestCloseTab,
  setQuickOpen,
  showSide,
} from './files-store'

const filesShown = (): boolean => {
  const s = layoutStore.getState()
  return s.panelOpen && s.panelView.kind === 'files'
}

/**
 * Files chords, registered while the app runs: Cmd+P (go to file) and Cmd+Shift+F (search in
 * files) open the Files panel from anywhere; Cmd+Shift+E shows the explorer and Cmd+W closes
 * the active file while the panel has focus.
 */
export function useFilesHotkeys(): void {
  useEffect(() => {
    const offs = [
      registerPageChord('cmd+p', () => {
        if (!filesShown()) showPanelTool('files')
        setQuickOpen(true)
        return 'consumed'
      }),
      registerPageChord('cmd+shift+f', () => {
        if (!filesShown()) showPanelTool('files')
        showSide('search')
        focusSearch()
        return 'consumed'
      }),
      registerPageChord('cmd+shift+e', () => {
        if (!filesShown()) showPanelTool('files')
        showSide('explorer')
        queueMicrotask(() =>
          document.querySelector<HTMLElement>('[data-testid=files-tree]')?.focus(),
        )
        return 'consumed'
      }),
      registerPageChord('cmd+w', () => {
        if (!filesShown() || !isPanelFocused()) return false
        const w = currentSpace(filesStore.getState())
        if (!w?.active) return false
        requestCloseTab(w.root, w.active)
        return 'consumed'
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [])
}
