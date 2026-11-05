import type { ChatRow } from '@evaos/contract'
import type { ActivityItem } from '@evaos/chat-core/activity'
import { sessionId } from '@evaos/chat-core/session-id'
import { activityStore } from '../activity/activity-store'
import { setOwnerResolver } from '../tabs/workspace-of'
import { refreshWorkspaces } from '../tiling/tiling-store'
import { listStore } from './list/list-store'

/** Owner links followed at most; a longer chain is a loop or a mistake. */
const MAX_CHAIN = 6

/**
 * The assistant at the end of `file`'s owner chain, as the host lists it (0.2.72): the chat
 * list's owner for a session an assistant started, else the activity feed's owner of that
 * session (`assistant:<id>`, or `session:<id>` to follow one more link). Null for Isaac's own.
 */
export function ownerChain(
  file: string,
  rows: readonly ChatRow[],
  items: readonly ActivityItem[],
): string | null {
  let id = sessionId(file)
  let row = rows.find((r) => r.file === file)
  for (let i = 0; i < MAX_CHAIN; i++) {
    if (row?.owner) return row.owner.agent
    const item = items.find(
      (x) =>
        x.open.to === 'chat' &&
        (x.open.session === id || x.open.thread === `session:${id}`) &&
        x.owner !== `session:${id}`,
    )
    const owner = item?.owner ?? null
    if (owner === null) return null
    if (owner.startsWith('assistant:')) return owner.slice('assistant:'.length) || null
    if (!owner.startsWith('session:')) return null
    id = owner.slice('session:'.length)
    row = rows.find((r) => r.id === id)
  }
  return null
}

/** Feeds the owner chain to the workspaces as the chat list and activity load. */
export function startWorkspaceOwners(): () => void {
  const resolve = (file: string): string | null =>
    ownerChain(file, listStore.getState().list?.rows ?? [], activityStore.getState().items)
  setOwnerResolver(resolve)
  const offList = listStore.subscribe((s, prev) => {
    if (s.list !== prev.list) refreshWorkspaces()
  })
  const offActivity = activityStore.subscribe((s, prev) => {
    if (s.items !== prev.items) refreshWorkspaces()
  })
  return () => {
    offList()
    offActivity()
    setOwnerResolver(() => null)
  }
}
