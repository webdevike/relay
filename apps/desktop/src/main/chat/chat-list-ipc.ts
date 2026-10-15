import type { ConfigStore } from '../config-store'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import type { WriteQueue } from '../write-queue'
import type { ChatListService } from './chat-list'
import type { SessionManager } from './session-manager'

const CHAT_FILE = 'chat.json'

/** One read-modify-write of chat.json that changes only `collapsed_groups`; unknown keys survive. */
export function saveCollapsed(config: ConfigStore, groups: readonly string[]): { saved: true } {
  const existing = config.readForMerge(CHAT_FILE)
  config.writeJson(CHAT_FILE, { ...existing, collapsed_groups: [...new Set(groups)] })
  return { saved: true }
}

/** Later plans add the other writes (pin, archive, categories) on the same queue. */
export function registerChatListIpc(
  ctx: MainContext,
  queue: WriteQueue,
  service: ChatListService,
  // Passed through for the rename and delete rules (single writer) in later plans.
  _manager: SessionManager,
): void {
  handle(ctx, 'chat.list', () => service.list())
  handle(ctx, 'chat.setCollapsed', ({ groups }) =>
    queue.enqueue(() => saveCollapsed(ctx.config, groups)),
  )
}
