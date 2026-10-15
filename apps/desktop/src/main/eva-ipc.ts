import { readSidebar } from '@evaos/eva-core'
import type { MainContext } from './context'
import { handle } from './ipc/handle'

/** Read-only: reads the Eva checkout, never writes it. Errors surface as an `internal` result. */
export function registerEvaIpc(ctx: MainContext): void {
  handle(ctx, 'eva.sidebar', () => readSidebar(ctx.env.evaRoot))
}
