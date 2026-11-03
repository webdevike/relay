import type { Boards } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayLink } from './client'

/**
 * `boards.list`, and `boards.changed` on every change Relay streams (a snapshot, a board written or
 * removed, the connection going down): the Dashboards section and each board's page.
 */
export function registerBoardsIpc(ctx: MainContext, relay: RelayLink): () => void {
  const list = (): Boards => {
    const boards = relay.boards()
    return { boards: boards === null ? [] : [...boards], relayUp: boards !== null }
  }
  handle(ctx, 'boards.list', list)
  return relay.onBoardsChange(() => emit(ctx, 'boards.changed', list()))
}
