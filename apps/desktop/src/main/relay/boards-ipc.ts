import type { Boards } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayLink, RelayQueries } from './client'

/**
 * `boards.list`, and `boards.changed` on every change Relay streams (a snapshot, a board written or
 * removed, the connection going down): the Dashboards section and each board's page. `boards.query`
 * runs a live widget's read-only query on the host (board tiles and canvas `ui` cards).
 */
export function registerBoardsIpc(ctx: MainContext, relay: RelayLink & RelayQueries): () => void {
  const list = (): Boards => {
    const boards = relay.boards()
    return {
      boards: boards === null ? [] : [...boards],
      relayUp: boards !== null,
      queries: boards !== null && relay.queriesUp(),
    }
  }
  handle(ctx, 'boards.list', list)
  handle(ctx, 'boards.query', ({ tool, args }) => relay.query(tool, args))
  return relay.onBoardsChange(() => emit(ctx, 'boards.changed', list()))
}
