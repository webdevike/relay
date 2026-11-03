import { notifications } from '@mantine/notifications'
import { invoke } from '../ipc'
import { chatStore } from './chat-store'

export const PANE_ID = 'pane-1'

let inflight: string | null = null
let draftInflight = false
/** Calls reach main in order, so the latest call is what main ends up holding; older results are dropped. */
let latest = 0

/**
 * Opens a session file into the chat pane. A no-op when the pane already shows it (and no other
 * open is in flight) or is loading it. Clicking the shown chat while another open is in flight
 * re-opens it, so main (which already took the other open) and the pane agree again.
 */
export async function openChatFile(file: string): Promise<void> {
  const shown = chatStore.getState().panes[PANE_ID]?.file === file
  if ((shown && inflight === null) || inflight === file) return
  inflight = file
  const mine = ++latest
  try {
    const r = await invoke('chat.open', { paneId: PANE_ID, file })
    if (mine !== latest) return
    if (r.ok) chatStore.getState().openPane(PANE_ID, { file, ...r.value })
    else notifications.show({ color: 'red', message: r.error.message, autoClose: 8000 })
  } finally {
    if (inflight === file) inflight = null
  }
}

/** Opens an empty `New chat` pane (chat.openDraft). A no-op while the pane is already an unused draft. */
export async function openDraftPane(): Promise<void> {
  const cur = chatStore.getState().panes[PANE_ID]
  if ((cur && cur.file === '') || draftInflight) return
  draftInflight = true
  const mine = ++latest
  try {
    const r = await invoke('chat.openDraft', { paneId: PANE_ID })
    if (r.ok && mine === latest) {
      chatStore.getState().openPane(PANE_ID, {
        file: '',
        title: 'New chat',
        messages: [],
        meta: r.value.meta,
      })
    }
  } finally {
    draftInflight = false
  }
}
