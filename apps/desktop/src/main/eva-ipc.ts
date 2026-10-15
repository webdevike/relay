import { readSidebar } from '@evaos/eva-core'
import type { MainContext } from './context'
import { registerDashboardIpc } from './eva/dashboard-ipc'
import { registerTodoIpc } from './eva/todo-ipc'
import { handle } from './ipc/handle'

/** Reads here; writes only through EvaFs in sibling modules. Errors surface as an `internal` result. */
export function registerEvaIpc(ctx: MainContext): void {
  handle(ctx, 'eva.sidebar', () => readSidebar(ctx.env.evaRoot))
  registerDashboardIpc(ctx)
  registerTodoIpc(ctx)
}
