import type { ActivityItem } from '@evaos/chat-core/activity'
import { placeOf } from '@evaos/shell-core'
import { chatStore } from '../chat/chat-store'
import type { DrillEntry } from '../chat/drill-store'
import { frontChatPaneOf } from '../chat/front-chat'
import { listStore } from '../chat/list/list-store'
import { invoke } from '../ipc'
import { openInApp } from '../navigation/open-in-app'
import type { OpenTarget } from '../navigation/open-target'
import { requestWatch } from '../terminal/terminal-watch'
import { openSubagentTab, revealTool } from '../tiling/tiling-store'

/**
 * What a click on an activity row or a composer chip does, the same for both: a session opens its
 * chat, a helper its transcript, a harness the Terminal tool attached to its pane view-only, a
 * canvas agent its room. A session the chat list does not span (an assistant started it in a
 * project folder, so its file sits in that folder's own sessions dir) opens its live transcript
 * beside the chat in front, the way a helper's does. With `drill` (a chip's plain click) a
 * transcript replaces the pane's view in place instead, and the caller keeps the way back.
 * Resolves to whether it went anywhere.
 */
export async function openActivity(
  item: ActivityItem,
  target: OpenTarget = 'here',
  drill?: (entry: DrillEntry) => void,
): Promise<boolean> {
  const to = item.open
  const transcript = (file: string, title: string): void => {
    if (drill) drill({ file, title, model: item.model, startedAt: item.startedAt })
    else
      openSubagentTab({
        session: chatStore.getState().panes[frontChatPaneOf()]?.file || '',
        file,
        name: title,
      })
  }
  switch (to.to) {
    case 'chat': {
      const row =
        to.session === undefined
          ? undefined
          : listStore.getState().list?.rows.find((r) => r.id === to.session)
      // A drill reads the transcript in place, so a session an assistant registered goes first;
      // without one the list's row opens its chat as before.
      if (row && !drill) {
        openInApp(placeOf('chat', { chat: row.file }), target)
        return true
      }
      if (to.session !== undefined) {
        const owned = await invoke('chat.ownedSession', { session: to.session }).catch(() => null)
        if (owned?.ok && owned.value !== null) {
          transcript(owned.value.file, item.title || owned.value.title)
          return true
        }
      }
      if (row) {
        openInApp(placeOf('chat', { chat: row.file }), target)
        return true
      }
      if (to.thread.startsWith('assistant:')) {
        openInApp(placeOf(`agent:${to.thread.slice('assistant:'.length)}`), target)
        return true
      }
      return false
    }
    case 'subagent':
      transcript(to.file, to.name)
      return true
    case 'terminal':
      requestWatch(to.pane, item.title)
      revealTool('terminal')
      return true
    case 'canvas':
      openInApp(placeOf('canvas', { canvas: to.slug }), target)
      return true
  }
}
