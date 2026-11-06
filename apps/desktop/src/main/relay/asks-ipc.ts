import { z } from 'zod'
import { OpenAskSchema, type AsksView, type OpenAsk } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayFrames, RelayLink } from './client'

/**
 * The host treats a socket as following an assistant's thread for five minutes after each
 * `assistant.get`; asking again before that keeps the thread's snapshots (and so its open asks)
 * coming while a chat shows it.
 */
export const ASK_FOLLOW_MS = 4 * 60_000

const SnapshotFrame = z.object({
  agent: z.string().min(1),
  snapshot: z.object({ asks: z.array(z.unknown()).optional() }),
})

/**
 * An `assistant.snapshot` frame's open asks (a bad one is dropped); null when the frame is another
 * kind, has no `asks` (a host that predates them) or names no agent.
 */
export function asksOf(frame: Record<string, unknown>): AsksView | null {
  if (frame['t'] !== 'assistant.snapshot') return null
  const s = SnapshotFrame.safeParse(frame)
  if (!s.success) return null
  const asks = s.data.snapshot.asks
  const parsed: OpenAsk[] | null =
    asks === undefined
      ? null
      : asks.flatMap((a) => {
          const r = OpenAskSchema.safeParse(a)
          return r.success ? [r.data] : []
        })
  return { agent: s.data.agent, asks: parsed }
}

/**
 * `asks.watch` / `unwatch` / `resolve` and `asks.changed`: an assistant thread's open asks as the
 * host keeps them (the questions Isaac has not answered, the phone's badges). A thread stays
 * watched while any chat shows it: its snapshot is asked for now, before the host's follow window
 * runs out and after every reconnect; the host pushes the next one whenever an ask opens or closes.
 */
export function registerAsksIpc(ctx: MainContext, relay: RelayFrames & RelayLink): () => void {
  const watched = new Map<string, number>()
  const last = new Map<string, string>()
  const held = new Map<string, OpenAsk[] | null>()
  const get = (agent: string): void => {
    relay.sendFrame({ t: 'assistant.get', agent })
  }
  handle(ctx, 'asks.watch', ({ agent }) => {
    watched.set(agent, (watched.get(agent) ?? 0) + 1)
    get(agent)
    return { agent, asks: held.get(agent) ?? null }
  })
  handle(ctx, 'asks.unwatch', ({ agent }) => {
    const left = (watched.get(agent) ?? 0) - 1
    if (left > 0) watched.set(agent, left)
    else if (watched.delete(agent)) {
      held.delete(agent)
      last.delete(agent)
    }
    return {}
  })
  handle(ctx, 'asks.resolve', async ({ agent, id, how, answer }) => {
    try {
      await relay.command({
        kind: 'assistant.ask.resolve',
        agent,
        id,
        how,
        ...(answer === undefined ? {} : { answer }),
      })
      return { sent: true }
    } catch {
      return { sent: false }
    }
  })
  const offFrame = relay.onFrame((f) => {
    if (f['t'] === 'welcome') {
      for (const agent of watched.keys()) get(agent)
      return
    }
    const view = asksOf(f)
    if (view === null || !watched.has(view.agent)) return
    const key = JSON.stringify(view.asks)
    if (last.get(view.agent) === key) return
    last.set(view.agent, key)
    held.set(view.agent, view.asks)
    emit(ctx, 'asks.changed', view)
  })
  const timer = setInterval(() => {
    for (const agent of watched.keys()) get(agent)
  }, ASK_FOLLOW_MS)
  timer.unref()
  return () => {
    offFrame()
    clearInterval(timer)
  }
}
