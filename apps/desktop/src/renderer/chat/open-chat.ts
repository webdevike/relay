import { invoke } from '../ipc'
import { chatStore } from './chat-store'
import { PANE_ID } from './SessionList'

let inflight: string | null = null
let draftInflight = false
/** Calls reach main in order, so the latest call is what main ends up holding; older results are dropped. */
let latest = 0

/** Opens a session file into the chat pane. A no-op when the pane already shows it or is loading it. */
export async function openChatFile(file: string): Promise<void> {
  if (chatStore.getState().panes[PANE_ID]?.file === file || inflight === file) return
  inflight = file
  const mine = ++latest
  try {
    const r = await invoke('chat.open', { paneId: PANE_ID, file })
    if (r.ok && mine === latest) chatStore.getState().openPane(PANE_ID, { file, ...r.value })
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
