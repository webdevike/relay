import { createElement } from 'react'
import { notifications } from '@mantine/notifications'
import type { ChatRow } from '@evaos/contract'
import type { ActivityItem } from '@evaos/chat-core/activity'
import { placeOf } from '@evaos/shell-core'
import { activityStore } from '../activity/activity-store'
import { listStore } from '../chat/list/list-store'
import { invoke } from '../ipc'
import { workspaceOfPlace } from '../tabs/workspace-of'
import { closeTab, inWorkspace, tilingStore, workspaceToolTabs } from '../tiling/tiling-store'
import { webPanelId } from '../tiling/web-tabs'
import { SessionPagesNote } from './SessionPagesNote'

/** A session an assistant owns that just finished, and the workspace it worked in. */
export interface EndedSession {
  /** Its omp session id. */
  session: string
  /** Its title, as its pages' `openedBy` names it. */
  title: string
  ws: string
}

const WAITING: ReadonlySet<string | null> = new Set(['needs-approval', 'has-question'])

const assistantWs = (ws: string): string | null => (ws.startsWith('page:agent:') ? ws : null)

/**
 * The sessions an assistant owns that finished between two reads of the chat list and the
 * activity feed: a row that stopped working (not to wait on Isaac) or that its assistant closed,
 * or a session item that went done or failed.
 */
export function endedSessions(
  prevRows: readonly ChatRow[],
  rows: readonly ChatRow[],
  prevItems: readonly ActivityItem[],
  items: readonly ActivityItem[],
): EndedSession[] {
  const out = new Map<string, EndedSession>()
  for (const row of rows) {
    const prev = prevRows.find((r) => r.id === row.id)
    if (!prev) continue
    const stopped =
      prev.status === 'working' && row.status !== 'working' && !WAITING.has(row.status)
    const closed = prev.owner?.closed === false && row.owner?.closed === true
    if (!stopped && !closed) continue
    const ws = assistantWs(workspaceOfPlace(placeOf('chat', { chat: row.file })))
    if (ws) out.set(row.id, { session: row.id, title: row.title, ws })
  }
  for (const item of items) {
    if (item.open.to !== 'chat' || !item.open.session) continue
    if (item.status !== 'done' && item.status !== 'failed') continue
    const prev = prevItems.find((i) => i.id === item.id)
    if (!prev || (prev.status !== 'working' && prev.status !== 'waiting')) continue
    const session = item.open.session
    if (out.has(session)) continue
    const row = rows.find((r) => r.id === session)
    const ws = row
      ? assistantWs(workspaceOfPlace(placeOf('chat', { chat: row.file })))
      : item.owner.startsWith('assistant:')
        ? `page:agent:${item.owner.slice('assistant:'.length)}`
        : null
    if (ws) out.set(session, { session, title: row?.title ?? item.title, ws })
  }
  return [...out.values()]
}

/** Closes pages `ids` (their tabs and browser pages) in workspace `ws`. */
function closePages(ws: string, ids: readonly string[]): void {
  const run = (): void => {
    for (const id of ids) {
      try {
        closeTab(webPanelId(id))
      } catch {
        // Closed or moved since.
      }
    }
  }
  if (ws === tilingStore.getState().scope) run()
  else inWorkspace(ws, run)
}

/** Offers to close the pages `end`'s session opened in its workspace, when any are open. */
async function offer(end: EndedSession): Promise<void> {
  const ids = workspaceToolTabs(end.ws).flatMap((t) => (t.kind === 'web' ? [t.id] : []))
  if (ids.length === 0) return
  const r = await invoke('browser.tabs.get', { ids: ids.slice(0, 64) })
  if (!r.ok) return
  const mine = r.value.tabs.filter((t) => t.openedBy === end.title).map((t) => t.id)
  if (mine.length === 0) return
  const id = `session-pages:${end.session}`
  notifications.show({
    id,
    color: 'gray',
    autoClose: 20_000,
    withCloseButton: false,
    message: createElement(SessionPagesNote, {
      count: mine.length,
      session: end.title,
      onClose: () => {
        notifications.hide(id)
        closePages(end.ws, mine)
      },
      onKeep: () => notifications.hide(id),
    }),
  })
}

/**
 * When a session an assistant owns finishes, offers to close the pages it opened in that
 * assistant's workspace (a quiet note with Close and Keep; nothing takes the focus). Returns the
 * unsubscribe.
 */
export function startSessionPages(): () => void {
  let rows = listStore.getState().list?.rows ?? []
  let items = activityStore.getState().items
  /** Sessions offered lately, so the list and the feed reporting one end offer once. */
  const offered = new Map<string, number>()
  const check = (): void => {
    const nextRows = listStore.getState().list?.rows ?? []
    const nextItems = activityStore.getState().items
    const ended = endedSessions(rows, nextRows, items, nextItems)
    rows = nextRows
    items = nextItems
    const now = Date.now()
    for (const end of ended) {
      if (now - (offered.get(end.session) ?? -Infinity) < 60_000) continue
      offered.set(end.session, now)
      void offer(end)
    }
  }
  const offList = listStore.subscribe((s, prev) => {
    if (s.list !== prev.list) check()
  })
  const offActivity = activityStore.subscribe((s, prev) => {
    if (s.items !== prev.items) check()
  })
  return () => {
    offList()
    offActivity()
  }
}
