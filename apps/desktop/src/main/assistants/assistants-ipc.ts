import type { Assistants } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayLink } from '../relay/client'
import { AssistantsService } from './assistants'

/** Relay's deltas come in bursts; one recompute per burst. */
const COALESCE_MS = 30
/**
 * A start acks only once the host's omp has registered, which the host allows 30 s
 * (REGISTER_TIMEOUT_MS in apps/linux/src/assistant/service.ts). Waiting longer lets the host's own
 * reason (no AI account, omp missing, herdr down) reach the page instead of "didn't answer in time".
 */
const START_TIMEOUT_MS = 45_000

/**
 * `assistants.list` / `assistants.start`, and `assistants.changed` whenever what the Assistants
 * area shows moves (Relay's session list, a thread's file). `refresh` schedules that check.
 */
export function registerAssistantsIpc(
  ctx: MainContext,
  relay: RelayLink,
  sessionsDirs: readonly string[],
): { list(): Assistants; refresh(): void; close(): void } {
  const service = new AssistantsService({
    evaRoot: ctx.env.evaRoot,
    sessionsDirs,
    relay: () => relay.sessions(),
  })
  let shown = ''
  const list = (): Assistants => {
    const out = service.list()
    shown = JSON.stringify(out)
    return out
  }
  handle(ctx, 'assistants.list', list)
  // Native start_assistant: the first words, "Hi <Title>", go through Relay as an assistant turn;
  // the next session list carries the thread.
  handle(ctx, 'assistants.start', async ({ agent }) => {
    const title = service.agents().find((a) => a.id === agent)?.title ?? agent
    await relay.command({ kind: 'assistant.turn', agent, text: `Hi ${title}` }, START_TIMEOUT_MS)
    return { started: true as const }
  })

  let timer: NodeJS.Timeout | undefined
  const refresh = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      const out = service.list()
      const next = JSON.stringify(out)
      if (next === shown) return
      shown = next
      emit(ctx, 'assistants.changed', out)
    }, COALESCE_MS)
  }
  const offRelay = relay.onChange(refresh)
  return {
    list: () => service.list(),
    refresh,
    close: () => {
      offRelay()
      clearTimeout(timer)
    },
  }
}
