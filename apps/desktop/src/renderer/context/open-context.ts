import { placeOf } from '@evaos/shell-core'
import type { ContextOpen } from '@evaos/contract'
import { chatStore } from '../chat/chat-store'
import { frontChatPaneOf } from '../chat/front-chat'
import { showPath } from '../files/files-store'
import { openInApp } from '../navigation/open-in-app'
import { openLink } from '../navigation/open-link'
import type { OpenTarget } from '../navigation/open-target'
import { requestExperiment } from '../test-bench/bench-request'
import { openSubagentTab, revealTool } from '../tiling/tiling-store'

/**
 * Opens what a context row (or an Agents board link) points at; an in-app page goes where
 * `target` says (default beside the chat).
 */
export function openContext(open: ContextOpen, target: OpenTarget): void {
  switch (open.kind) {
    case 'url':
      openLink(open.url, { target })
      break
    case 'files':
      revealTool('files')
      void showPath(open.path, chatStore.getState().panes[frontChatPaneOf()]?.file || null)
      break
    case 'chat':
      openInApp(placeOf('chat', { chat: open.file }), target)
      break
    case 'subagent':
      openSubagentTab({ session: open.session, file: open.file, name: open.name })
      break
    case 'experiment':
      requestExperiment(open.id)
      openInApp(placeOf('test-bench'), target)
      break
    case 'jobs':
      openInApp(placeOf('jobs'), target)
      break
  }
}
