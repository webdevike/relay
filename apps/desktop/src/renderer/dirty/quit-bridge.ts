import { invoke, on } from '../ipc'
import { listDirty, saveAllDirty } from './dirty-store'

/** Answers main's quit-guard requests from the dirty registry (D-18). */
export function startQuitBridge(): () => void {
  const offA = on('app.unsavedEdits.request', ({ id }) => {
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
