import { placeOf, type Place } from '@evaos/shell-core'
import { invoke, on } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { tabsStore } from '../tabs/tabs-store'
import { tilingStore, visiblePanes } from '../tiling/tiling-store'

/**
 * The threads the window shows, as main's notification policy names them: `assistant:<id>` for an
 * assistant's page and `chat:<session file>` for a chat (a draft is no thread yet).
 */
export function threadsOf(places: readonly Place[]): string[] {
  const out = new Set<string>()
  for (const p of places) {
    if (p.page.startsWith('agent:')) out.add(`assistant:${p.page.slice('agent:'.length)}`)
    else if (p.page === 'chat' && p.chat !== null && p.chat !== 'draft') out.add(`chat:${p.chat}`)
  }
  return [...out]
}

/**
 * The window's half of desktop notifications: tells main which chats are in front now and after
 * every change (those stay quiet), and opens the chat of a clicked notification. A clicked link
 * (an assistant, a canvas, Settings) arrives as `app.openLink`, which navigation/deep-links.ts opens.
 */
export function startNotificationBridge(): () => void {
  let sent = ''
  const report = (): void => {
    const tabs = tabsStore.getState().tabs.list
    const front = new Set(visiblePanes(tilingStore.getState()).map((p) => p.active))
    const threads = threadsOf(tabs.filter((t) => front.has(`tab:${t.id}`)).map((t) => t.here))
    const next = JSON.stringify(threads)
    if (next === sent) return
    sent = next
    void invoke('notifications.visible', { threads }).catch(() => undefined)
  }
  const offTiling = tilingStore.subscribe(report)
  const offOpen = on('chat.openRequested', ({ file }) => openPlace(placeOf('chat', { chat: file })))
  const offTabs = tabsStore.subscribe(report)
  report()
  return () => {
    offTiling()
    offTabs()
    offOpen()
  }
}
