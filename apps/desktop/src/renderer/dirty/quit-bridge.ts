import { invoke, on } from '../ipc'
import { flushPendingTabs } from '../tabs/tabs-store'
import { flushSave } from '../tiling/tiling-store'
import { flushUiPrefs } from '../ui-prefs'
import { listDirty, saveAllDirty } from './dirty-store'

/** Answers main's quit-guard requests from the dirty registry (D-18). */
export function startQuitBridge(): () => void {
  const offA = on('app.unsavedEdits.request', ({ id }) => {
    // Quit is starting: persist any debounced tab or pane change before the renderer can die.
    flushPendingTabs()
    flushSave()
    flushUiPrefs()
    void invoke('app.unsavedEdits.reply', { id, entries: listDirty() }).catch(() => {})
  })
  const offB = on('app.saveDirty.request', ({ id }) => {
    void saveAllDirty()
      .then((failures) => invoke('app.saveDirty.reply', { id, failures }))
      .catch(() => {})
  })
  return () => {
    offA()
    offB()
  }
}
