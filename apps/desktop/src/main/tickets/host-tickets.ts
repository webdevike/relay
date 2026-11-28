// Synced Linear tickets from the Relay Host: `tickets.req {rid, op}` answered by `tickets.res`
// with the same rid, and once this connection sent `subscribe`, `tickets.snapshot`/`delta`/`status`
// pushes (relay packages/protocol/src/tickets.ts). An old host closes the socket on an unknown
// frame, so nothing goes out unless the host lists TICKETS_FEATURE; every other case answers a
// fallback reason instead.
import {
  TICKETS_FEATURE,
  TicketsBoard,
  TicketsOp,
  TicketsResult,
  TicketsServerFrames,
  TicketsStatus,
  type TicketBoardFacts,
  type TicketPlanProposal,
  type TicketsOpKind,
} from '@relay/protocol'
import type { TicketsFallback, TicketsFallbackReason } from '@evaos/contract'
import type { RelayFeatures, RelayFrames, RelaySource } from '../relay/client'

export const TICKETS_MESSAGES: Record<TicketsFallbackReason, string> = {
  noHost: 'Linear sync needs the Relay Host.',
  oldHost: 'The Mini’s Relay Host can’t sync Linear yet. Update it to see synced tickets.',
  off: 'Linear sync is off on the host.',
  disconnected: 'Not connected to the Mini’s Relay Host.',
}

const TIMEOUT_MS: Partial<Record<TicketsOpKind, number>> = {
  summary: 60_000,
  commit: 60_000,
  replan: 120_000,
}
export const DEFAULT_TICKETS_TIMEOUT_MS = 20_000

export interface TicketsView {
  readonly rev: number
  readonly board: TicketsBoard
  readonly status: TicketsStatus
}

/** The host's answer, or why there is none (nothing was sent, or nothing came back). */
export type TicketsAnswer = { ok: true; res: TicketsResult } | TicketsFallback

/** keys: changed tickets (null: the whole board); status when it moved. */
export type TicketsListener = (keys: string[] | null, status?: TicketsStatus) => void

export interface HostTickets {
  /** The latest board this connection holds; null before the first snapshot or when not served. */
  snapshot(): TicketsView | null
  /** The board now: the held one, else asked for. */
  board(): Promise<({ ok: true } & TicketsView) | TicketsFallback>
  /**
   * One op; a host error (`ok:false` without `refused` or `outcome`) rejects with its line. A
   * write the gate answered `ok:false` with its outcome (a failed or partly failed `applyPlan`)
   * resolves, so the caller sees each row's own state.
   */
  req(op: TicketsOp): Promise<TicketsAnswer>
  onChange(cb: TicketsListener): () => void
  stop(): void
}

const [ResFrame, SnapshotFrame, DeltaFrame, StatusFrame] = TicketsServerFrames

type Frames = RelayFrames & RelayFeatures & Partial<Pick<RelaySource, 'onChange'>>

export function fallback(reason: TicketsFallbackReason): TicketsFallback {
  return { source: 'fallback', reason, message: TICKETS_MESSAGES[reason] }
}

/** A plain host answer: `{source:'host', ...pick(result)}`, or the fallback as is. */
export async function ask<T extends object>(
  host: Pick<HostTickets, 'req'>,
  op: TicketsOp,
  pick: (res: TicketsResult) => T,
): Promise<({ source: 'host' } & T) | TicketsFallback> {
  const a = await host.req(op)
  return 'ok' in a ? { source: 'host', ...pick(a.res) } : a
}

type Refusal = NonNullable<TicketsResult['refused']>

/** `tickets.replan`: Astra's validated proposal, or the host's refusal (not a readable plan). */
export function replan(
  host: Pick<HostTickets, 'req'>,
  scope: { projectId: string; milestoneId?: string | undefined },
): Promise<
  ({ source: 'host' } & ({ refused: Refusal } | { proposal: TicketPlanProposal })) | TicketsFallback
> {
  const { projectId, milestoneId } = scope
  const op: TicketsOp = { kind: 'replan', projectId, ...(milestoneId ? { milestoneId } : {}) }
  return ask<{ refused: Refusal } | { proposal: TicketPlanProposal }>(host, op, (res) => {
    if (res.refused) return { refused: res.refused }
    if (!res.proposal) throw new Error('The Mini’s Relay Host sent no plan.')
    return { proposal: res.proposal }
  })
}

export function createHostTickets(
  frames: Frames,
  timeouts: (kind: TicketsOpKind) => number = (k) => TIMEOUT_MS[k] ?? DEFAULT_TICKETS_TIMEOUT_MS,
): HostTickets {
  let seq = 0
  let view: TicketsView | null = null
  let status: TicketsStatus | null = null
  let subscribed = false
  let gapAsk = false
  const listeners = new Set<TicketsListener>()
  const notify = (keys: string[] | null, s?: TicketsStatus): void => {
    for (const cb of [...listeners]) cb(keys, s)
  }

  /** Why no frame may go out now, or null when the host serves tickets. */
  function unserved(): TicketsFallbackReason | null {
    if (frames.hostHas(TICKETS_FEATURE)) return null
    // hostHas is false both offline and on an old host; a ping goes out only on a live connection.
    return frames.sendFrame({ t: 'ping', ts: Date.now() }) ? 'oldHost' : 'disconnected'
  }

  function send(op: TicketsOp): Promise<TicketsAnswer> {
    seq += 1
    const rid = `relay-desktop-tickets-${Date.now().toString(36)}-${seq}`
    const { promise, resolve, reject } = Promise.withResolvers<TicketsAnswer>()
    const done = (): void => {
      clearTimeout(timer)
      off()
    }
    const timer = setTimeout(() => {
      off()
      resolve(fallback('disconnected'))
    }, timeouts(op.kind))
    const off = frames.onFrame((f) => {
      if (f.t !== 'tickets.res' || f.rid !== rid) return
      done()
      const res = ResFrame.safeParse(f)
      if (!res.success)
        reject(new Error('The Mini’s Relay Host sent an answer this app can’t read.'))
      else if (res.data.ok || res.data.refused || res.data.outcome)
        resolve({ ok: true, res: res.data })
      else reject(new Error(res.data.error ?? 'The Mini’s Relay Host refused that.'))
    })
    if (!frames.sendFrame({ t: 'tickets.req', rid, op })) {
      done()
      resolve(fallback('disconnected'))
    }
    return promise
  }

  async function req(op: TicketsOp): Promise<TicketsAnswer> {
    const reason = unserved()
    if (reason) return fallback(reason)
    return send(TicketsOp.parse(op))
  }

  function take(res: TicketsResult): TicketsView | null {
    if (res.status) status = res.status
    if (!res.board || res.rev === undefined || !status) return null
    view = { rev: res.rev, board: res.board, status }
    notify(null, status)
    return view
  }

  function subscribe(): void {
    if (subscribed || !frames.hostHas(TICKETS_FEATURE)) return
    subscribed = true
    void send({ kind: 'subscribe', on: true }).then(
      (a) => {
        if ('ok' in a) take(a.res)
        else subscribed = false
      },
      () => {
        subscribed = false
      },
    )
  }

  /** A delta that doesn't follow the held rev: ask for the whole board once. */
  function recover(): void {
    if (gapAsk) return
    gapAsk = true
    void req({ kind: 'board' })
      .then((a) => {
        if ('ok' in a) take(a.res)
      })
      .catch(() => undefined)
      .finally(() => {
        gapAsk = false
      })
  }

  function applyDelta(f: Record<string, unknown>): void {
    const d = DeltaFrame.safeParse(f)
    if (!d.success) return
    if (!view || d.data.base !== view.rev) return recover()
    const gone = new Set<string>([...d.data.tombstones, ...d.data.upserts.map((t) => t.key)])
    const tickets: TicketBoardFacts[] = view.board.tickets.filter((t) => !gone.has(t.key))
    tickets.push(...d.data.upserts)
    if (d.data.status) status = d.data.status
    // Deltas carry no teams: keep the snapshot's.
    view = { rev: d.data.rev, board: { ...view.board, tickets }, status: status ?? view.status }
    notify([...d.data.upserts.map((t) => t.key), ...d.data.tombstones], d.data.status ?? undefined)
  }

  function onPush(f: Record<string, unknown>): void {
    if (f.t === 'tickets.delta') return applyDelta(f)
    if (f.t === 'tickets.snapshot') {
      const s = SnapshotFrame.safeParse(f)
      if (s.success) take({ rid: 'push', ok: true, ...s.data })
      return
    }
    const s = StatusFrame.safeParse(f)
    if (!s.success) return
    status = s.data.status
    if (view) view = { ...view, status }
    notify([], status)
  }

  const offFrames = frames.onFrame((f) => {
    if (f.t === 'welcome') {
      // A new connection: pushes stop until it subscribes again; the board may have moved.
      subscribed = false
      view = null
      notify(null)
      subscribe()
      return
    }
    if (typeof f.t === 'string' && f.t.startsWith('tickets.') && f.t !== 'tickets.res') onPush(f)
  })
  const offChange =
    frames.onChange?.(() => {
      if (!view || frames.hostHas(TICKETS_FEATURE)) return
      view = null
      subscribed = false
      notify(null)
    }) ?? (() => undefined)
  subscribe()
  const snapshot = (): TicketsView | null => (view && frames.hostHas(TICKETS_FEATURE) ? view : null)

  return {
    snapshot,
    async board() {
      const held = snapshot()
      if (held) return { ok: true, ...held }
      const a = await req({ kind: 'board' })
      if (!('ok' in a)) return a
      subscribe()
      const got = take(a.res)
      return got ? { ok: true, ...got } : fallback('disconnected')
    },
    req,
    onChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    stop() {
      offFrames()
      offChange()
      listeners.clear()
    },
  }
}
