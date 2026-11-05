import type { ActivityItem } from '@evaos/chat-core/activity'
import { placeOf } from '@evaos/shell-core'
import { chatStore } from '../chat/chat-store'
import { frontChatPaneOf } from '../chat/front-chat'
import { listStore } from '../chat/list/list-store'
import { openInApp } from '../navigation/open-in-app'
import type { OpenTarget } from '../navigation/open-target'
import { requestWatch } from '../terminal/terminal-watch'
import { openSubagentTab, revealTool } from '../tiling/tiling-store'

/**
 * What a click on an activity row or a composer chip does, the same for both: a session opens its
 * chat, a helper its transcript, a harness the Terminal tool attached to its pane view-only, a
 * canvas agent its room. Returns whether it went anywhere (a chat the list does not know does not).
 */
export function openActivity(item: ActivityItem, target: OpenTarget = 'here'): boolean {
  const to = item.open
  switch (to.to) {
    case 'chat': {
      const row =
        to.session === undefined
          ? undefined
          : listStore.getState().list?.rows.find((r) => r.id === to.session)
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
      openSubagentTab({
        session: chatStore.getState().panes[frontChatPaneOf()]?.file || '',
        file: to.file,
        name: to.name,
      })
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
