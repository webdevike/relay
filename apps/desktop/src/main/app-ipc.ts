import { app } from 'electron'
import type { MainContext } from './context'
import { emit, handle } from './ipc/handle'

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
      noMotion: ctx.env.noMotion,
      instance: ctx.env.instance,
      build: ctx.env.build,
      profile: ctx.env.profile,
      setupComplete: ctx.env.setupComplete,
      homeRoot: ctx.env.homeRoot,
    }
  })
  // The page stays "visible" while the window is hidden (background throttling is off), so what
  // only animates (assistant portraits) hears from here when nothing of the window shows.
  const shown = (): void =>
    emit(ctx, 'app.windowShown', { shown: ctx.win.isVisible() && !ctx.win.isMinimized() })
  ctx.win.on('show', shown)
  ctx.win.on('hide', shown)
  ctx.win.on('minimize', shown)
  ctx.win.on('restore', shown)
}
