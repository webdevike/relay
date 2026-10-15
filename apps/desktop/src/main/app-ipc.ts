import { app } from 'electron'
import type { MainContext } from './context'
import { handle } from './ipc/handle'

export function registerAppIpc(ctx: MainContext): void {
  handle(ctx, 'app.info', () => {
    const state = ctx.config.readJson<{ launchCount?: number }>('app-state.json', {})
    return {
      evaRoot: ctx.env.evaRoot,
      configDir: ctx.env.configDir,
      ompBin: ctx.env.ompBin,
      sessionsDir: ctx.env.sessionsDir,
      live: ctx.env.live,
      e2e: ctx.env.e2e,
      launchCount: state.launchCount ?? 0,
      version: app.getVersion(),
    }
  })
}
