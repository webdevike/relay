import { invoke } from '../ipc'
import { chatStore } from './chat-store'
import { PANE_ID } from './SessionList'

let inflight: string | null = null

/** Opens a session file into the chat pane. A no-op when the pane already shows it or is loading it. */
export async function openChatFile(file: string): Promise<void> {
  if (chatStore.getState().panes[PANE_ID]?.file === file || inflight === file) return
  inflight = file
  try {
    const r = await invoke('chat.open', { paneId: PANE_ID, file })
    if (r.ok) chatStore.getState().openPane(PANE_ID, { file, ...r.value })
  } finally {
    if (inflight === file) inflight = null
  }
}
