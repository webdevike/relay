import type { DashboardPayload } from '@evaos/eva-core/model/dashboard'
import { readDashboard } from '@evaos/eva-core/model/read-eva'
import type { MainContext } from '../context'
import { handle } from '../ipc/handle'
import { clockFor } from './runtime'

/** Read-only: the renderer sends no paths; the root is fixed by the environment (T-03-30). */
export function dashboardHandler(
  root: string,
  clock: { now(): Date; today(): string },
): DashboardPayload {
  return readDashboard(root, clock.today(), clock.now().getTime())
}

export function registerDashboardIpc(ctx: MainContext): void {
  handle(ctx, 'eva.dashboard', () => dashboardHandler(ctx.env.evaRoot, clockFor(ctx)))
}
