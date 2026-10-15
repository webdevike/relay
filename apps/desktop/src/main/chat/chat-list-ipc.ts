import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import type { WriteQueue } from '../write-queue'
import type { ChatListService } from './chat-list'

/** Read-only in this slice: later plans add the writes (pin, archive, categories) on the queue. */
export function registerChatListIpc(
  ctx: MainContext,
  _queue: WriteQueue,
  service: ChatListService,
): void {
  handle(ctx, 'chat.list', () => service.list())
}
