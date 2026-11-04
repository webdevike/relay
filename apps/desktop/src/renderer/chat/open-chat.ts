import { notifications } from '@mantine/notifications'
import { invoke } from '../ipc'
import { chatStore } from './chat-store'
import { dropLocalRows } from './local-rows'

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

let chatPanes = 0

/**
 * A new id for the chat an app tab shows while it is on screen (never one used before, so a
 * drop of the last mount's pane can never land on this one).
 */
export function newChatPaneId(): string {
  chatPanes += 1
  return `pane-${chatPanes}`
}

/**
 * Opens a session file into chat pane `paneId`. A no-op when the pane already shows it (and no
 * other open is in flight) or is loading it. Opening the shown chat while another open is in
 * flight re-opens it, so main (which already took the other open) and the pane agree again;
 * older results are dropped.
 */
export async function openChatFile(file: string, paneId: string): Promise<void> {
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

/** Opens an empty `New chat` in `paneId` (chat.openDraft). A no-op while it is already an unused draft. */
export async function openDraftPane(paneId: string): Promise<void> {
  const o = openingOf(paneId)
  const cur = chatStore.getState().panes[paneId]
  if ((cur && cur.file === '') || o.draftInflight) return
  o.draftInflight = true
  const mine = ++o.latest
  try {
    const r = await invoke('chat.openDraft', { paneId })
    o.sent = Promise.resolve(r)
    if (r.ok && mine === o.latest) {
      chatStore.getState().openPane(paneId, {
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
 * A chat pane went away (its tab closed or went behind another): the store forgets it at once,
 * an open in flight lands nowhere, and main forgets it once that open has answered (it may still
 * be fetching the file, then registers).
 */
export function dropChatPane(paneId: string): void {
  const o = opening.get(paneId)
  opening.delete(paneId)
  if (o) o.latest += 1
  chatStore.getState().dropPane(paneId)
  dropLocalRows(paneId)
  void (o?.sent ?? Promise.resolve()).then(() => invoke('chat.drop', { paneId }))
}
