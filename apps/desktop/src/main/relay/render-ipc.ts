import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import type { RelayRender } from './client'

/**
 * `render.failed`: media in a chat bubble failed to show. Passed on to the host, which tells the
 * owning agent so it reposts a form that renders; dropped when the host is down or too old.
 */
export function registerRenderIpc(ctx: MainContext, relay: RelayRender): void {
  handle(ctx, 'render.failed', (failure) => ({ sent: relay.reportRender(failure) }))
}
