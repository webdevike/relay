import { notifications } from '@mantine/notifications'
import { invoke } from '../ipc'
import { chatStore } from './chat-store'

/** Main's chat pane: the app tab in front shows here. */
export const PANE_ID = 'pane-1'

/** Each pane's opens in flight; calls reach main in order, so the latest is what main holds. */
interface Opening {
  inflight: string | null
  draftInflight: boolean
  latest: number
  /** The last `chat.open` sent, settled or not: a drop waits for it so main forgets last. */
  sent: Promise<unknown>
}

const opening = new Map<string, Opening>()

function openingOf(paneId: string): Opening {
  let o = opening.get(paneId)
  if (!o) {
    o = { inflight: null, draftInflight: false, latest: 0, sent: Promise.resolve() }
    opening.set(paneId, o)
  }
  return o
}

let toolPanes = 0

/** A new id for a chat a tool pane's tab shows (never main's, never one used before). */
export function newToolPaneId(): string {
  toolPanes += 1
  return `tool-${toolPanes}`
}

/**
 * Opens a session file into chat pane `paneId` (main's by default). A no-op when the pane already
 * shows it (and no other open is in flight) or is loading it. Clicking the shown chat while
 * another open is in flight re-opens it, so main (which already took the other open) and the pane
 * agree again; older results are dropped.
 */
export async function openChatFile(file: string, paneId = PANE_ID): Promise<void> {
  const o = openingOf(paneId)
  const shown = chatStore.getState().panes[paneId]?.file === file
  if ((shown && o.inflight === null) || o.inflight === file) return
  o.inflight = file
  const mine = ++o.latest
  try {
    const sent = invoke('chat.open', { paneId, file })
    o.sent = sent.catch(() => undefined)
    const r = await sent
    if (mine !== o.latest) return
    if (r.ok) chatStore.getState().openPane(paneId, { file, ...r.value })
    else notifications.show({ color: 'red', message: r.error.message, autoClose: 8000 })
  } finally {
    if (o.inflight === file) o.inflight = null
  }
}

/** Opens an empty `New chat` in main's pane (chat.openDraft). A no-op while it is already an unused draft. */
export async function openDraftPane(): Promise<void> {
  const o = openingOf(PANE_ID)
  const cur = chatStore.getState().panes[PANE_ID]
  if ((cur && cur.file === '') || o.draftInflight) return
  o.draftInflight = true
  const mine = ++o.latest
  try {
    const r = await invoke('chat.openDraft', { paneId: PANE_ID })
    if (r.ok && mine === o.latest) {
      chatStore.getState().openPane(PANE_ID, {
        file: '',
        title: 'New chat',
        messages: [],
        meta: r.value.meta,
      })
    }
  } finally {
    o.draftInflight = false
  }
}

/**
 * A tool pane's chat went away: the store forgets it at once, an open in flight lands nowhere, and
 * main forgets it once that open has answered (it may still be fetching the file, then registers).
 */
export function dropChatPane(paneId: string): void {
  const o = opening.get(paneId)
  opening.delete(paneId)
  if (o) o.latest += 1
  chatStore.getState().dropPane(paneId)
  void (o?.sent ?? Promise.resolve()).then(() => invoke('chat.drop', { paneId }))
}
