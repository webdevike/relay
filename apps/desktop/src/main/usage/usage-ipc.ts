import * as os from 'node:os'
import type { MainContext } from '../context'
import { buildCommand, childPathFor, runCapture } from '../eva/spawn'
import { emit, handle } from '../ipc/handle'
import { createUsageService, USAGE_POLL_MS } from './usage-service'

/** Plan usage for every omp profile: polled every 5 minutes, on window focus and on demand. */
export function registerUsageIpc(ctx: MainContext): void {
  const home = os.homedir()
  const service = createUsageService({
    profilesDir: ctx.env.ompProfilesDir,
    run: async (profile, timeoutMs) => {
      const cmd = buildCommand(ctx.env.ompBin, ['--profile', profile, 'usage', '--json'], {
        pathEnv: await childPathFor(ctx.env.live, home),
        homedir: home,
        execPath: process.execPath,
        baseEnv: process.env,
      })
      return runCapture(cmd, home, timeoutMs)
    },
    emit: (snapshot) => emit(ctx, 'usage.changed', snapshot),
  })
  handle(ctx, 'usage.get', () => service.get())
  handle(ctx, 'usage.refresh', () => service.refresh())
  ctx.win.on('focus', () => service.refreshIfOld())
  const timer = setInterval(() => void service.refresh(), USAGE_POLL_MS)
  timer.unref()
  void service.refresh()
}
