import { powerMonitor } from 'electron'
import type { UpdateState } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import { shouldAutoRestart } from './policy'

const CHECK_MS = 60_000

export interface UpdateHandle {
  state(): UpdateState
  /** Records a new build to restart into; a second offer replaces the first. */
  offer(update: { summary: string; build: string }): { pending: true }
}

/**
 * A deployed build waiting for a restart (agent action `update.offer`). The renderer shows it
 * as a toast and a footer chip; `restart` runs the normal quit path with exit code 75 so the
 * supervisor relaunches the app. While one is pending, the app also restarts on its own when
 * shouldAutoRestart says Isaac is away at night.
 */
export function registerUpdate(
  ctx: MainContext,
  deps: { chatWorking(): boolean; restart(): void },
): UpdateHandle {
  let state: UpdateState = { pending: false, build: null, summary: null }
  let timer: NodeJS.Timeout | undefined

  handle(ctx, 'update.state', () => state)
  handle(ctx, 'update.restart', () => {
    deps.restart()
    return {}
  })
  ctx.onBeforeQuit(async () => clearInterval(timer))

  return {
    state: () => state,
    offer({ summary, build }) {
      state = { pending: true, build, summary }
      // A page that is not loaded yet reads update.state when it starts.
      emit(ctx, 'update.changed', state)
      timer ??= setInterval(() => {
        const restart = shouldAutoRestart({
          pending: state.pending,
          idleSeconds: powerMonitor.getSystemIdleTime(),
          now: new Date(),
          chatWorking: deps.chatWorking(),
        })
        if (restart) deps.restart()
      }, CHECK_MS)
      return { pending: true }
    },
  }
}
