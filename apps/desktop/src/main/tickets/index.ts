// The `tickets.*` IPC: the host's synced Linear tickets through host-tickets.ts, or a fallback
// reason (the Board then keeps its local agent cards). Pushes become one debounced
// `tickets.changed`; main/agents-board reads the board with `ticketsSnapshot()` and refreshes on
// `onTicketsChanged`.
import {
  HandledTarget,
  MAX_TICKET_WATCH,
  MAX_TICKET_WATCH_TTL_MS,
  TicketMutation,
  type TicketsOp,
  type TicketsResult,
  type TicketsStatus,
} from '@relay/protocol'
import type { TicketsFallback } from '@evaos/contract'
import type { MainContext } from '../context'
import { emit, handle } from '../ipc/handle'
import type { RelayFeatures, RelayFrames, RelaySource } from '../relay/client'
import { createHostTickets, fallback, type HostTickets, type TicketsView } from './host-tickets'

/** Push bursts become one `tickets.changed`, like `agents.changed`. */
const CHANGED_DEBOUNCE_MS = 400
/** A watch outlives a few board loads; the board refreshes it well before. */
const WATCH_TTL_MS = Math.min(10 * 60_000, MAX_TICKET_WATCH_TTL_MS)

let bridge: HostTickets | null = null

/** The host's board as this launch holds it; null when the host doesn't serve tickets. */
export function ticketsSnapshot(): TicketsView | null {
  return bridge?.snapshot() ?? null
}

const changedHooks = new Set<(keys: string[] | null) => void>()
/** Runs on every (debounced) tickets change; answers the unsubscribe. */
export function onTicketsChanged(cb: (keys: string[] | null) => void): () => void {
  changedHooks.add(cb)
  return () => changedHooks.delete(cb)
}

/** Keeps these keys synced although they aren't Isaac's (agent cards' keys the board lacks). */
export function ticketsWatch(keys: readonly string[]): void {
  if (!bridge || keys.length === 0) return
  const op = { kind: 'watch', keys: keys.slice(0, MAX_TICKET_WATCH), ttlMs: WATCH_TTL_MS } as const
  void bridge.req(op).catch(() => undefined)
}

/** A plain host answer: `{source:'host', ...pick(result)}`, or the fallback as is. */
async function ask<T extends object>(
  host: HostTickets,
  op: TicketsOp,
  pick: (res: TicketsResult) => T,
): Promise<({ source: 'host' } & T) | TicketsFallback> {
  const a = await host.req(op)
  return 'ok' in a ? { source: 'host', ...pick(a.res) } : a
}

export function registerTicketsIpc(
  ctx: MainContext,
  frames: RelayFrames & RelayFeatures & Pick<RelaySource, 'onChange'>,
): () => void {
  const host = createHostTickets(frames)
  bridge = host
  let timer: ReturnType<typeof setTimeout> | null = null
  let keys: Set<string> | null = new Set()
  let status: TicketsStatus | undefined
  const flush = (): void => {
    timer = null
    const payload = { keys: keys ? [...keys] : null, ...(status ? { status } : {}) }
    keys = new Set()
    status = undefined
    emit(ctx, 'tickets.changed', payload)
    for (const cb of [...changedHooks]) cb(payload.keys)
  }
  const offChange = host.onChange((k, s) => {
    if (k === null) keys = null
    else if (keys) for (const key of k) keys.add(key)
    if (s) status = s
    timer ??= setTimeout(flush, CHANGED_DEBOUNCE_MS)
  })

  handle(ctx, 'tickets.board', async () => {
    const b = await host.board()
    if (!('ok' in b)) return b
    if (!b.status.features.tickets) return fallback('off')
    return { source: 'host', rev: b.rev, board: b.board, status: b.status }
  })
  handle(ctx, 'tickets.ticket', ({ key }) =>
    ask(host, { kind: 'ticket', key }, (res) => {
      if (!res.ticket) throw new Error(`The Mini’s Relay Host has no ${key}.`)
      return { ticket: res.ticket }
    }),
  )
  handle(ctx, 'tickets.watch', ({ keys: watch }) =>
    ask(host, { kind: 'watch', keys: watch, ttlMs: WATCH_TTL_MS }, () => ({})),
  )
  handle(ctx, 'tickets.sync', () => ask(host, { kind: 'sync' }, () => ({})))
  handle(ctx, 'tickets.seen', ({ key }) =>
    ask(host, { kind: 'seen', key }, (res) => ({
      previousSeenAt: res.previousSeenAt ?? null,
    })),
  )
  handle(ctx, 'tickets.handled', ({ target, undo }) =>
    ask(host, { kind: 'handled', target: HandledTarget.parse(target), undo }, () => ({})),
  )
  handle(ctx, 'tickets.prepare', ({ mutation }) =>
    ask(host, { kind: 'prepare', mutation: TicketMutation.parse(mutation) }, (res) =>
      res.refused ? { refused: res.refused } : { approval: res.approval },
    ),
  )
  handle(ctx, 'tickets.commit', ({ approvalId, opId, mutation }) =>
    ask(
      host,
      {
        kind: 'commit',
        opId,
        mutation: TicketMutation.parse(mutation),
        ...(approvalId === undefined ? {} : { approvalId }),
      },
      (res) => (res.refused ? { refused: res.refused } : { outcome: res.outcome }),
    ),
  )
  handle(ctx, 'tickets.summary', ({ key }) =>
    ask(host, { kind: 'summary', key }, (res) => {
      if (!res.summary) throw new Error('The Mini’s Relay Host sent no summary.')
      return { summary: res.summary }
    }),
  )

  return () => {
    clearTimeout(timer ?? undefined)
    offChange()
    host.stop()
    if (bridge === host) bridge = null
  }
}
