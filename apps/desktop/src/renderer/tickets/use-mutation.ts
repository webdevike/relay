// One generic lifecycle for every ticket write through the host's gate (PLAN §2.5, §6): a confirmed
// kind is `prepare`d, shown to Isaac (`confirming`, the host's approval in full: summary, exact
// text, quote, every row) and committed with the approval; others commit at once. Every op carries
// the Linear account the page showed (`viewerId`); the host refuses when it writes as another. The
// opId is minted once per `run` and reused by `retry`, so a lost answer never writes twice: the host
// answers the stored outcome (or reconciles) instead.
import { useCallback, useRef, useState } from 'react'
import {
  TicketApproval,
  TicketOutcome,
  ticketMutationConfirmed,
  type TicketConfirm,
  type TicketMutation,
} from '@relay/protocol'
import { invoke } from '../ipc'

export type MutationView =
  | { kind: 'idle' }
  | { kind: 'preparing' | 'committing' }
  /** The UI shows an EvaModal with the host's approval in full (`ApprovalNote`); confirm() commits. */
  | { kind: 'confirming'; approval: TicketConfirm }
  | { kind: 'done' }
  | { kind: 'refused'; message: string }
  /** The answer was lost: it may or may not have been written. retry() asks again (same opId). */
  | { kind: 'unknown'; message: string }
  | { kind: 'failed'; message: string }

export const CHECKING = 'Checking whether it posted'
/** No Linear account on the page yet (host not answered, or no sync): nothing is sent. */
export const NO_ACCOUNT =
  'The host hasn’t said which Linear account it writes as yet. Reload and try again.'

type Step =
  | { kind: 'approval'; id: string; approval: TicketConfirm }
  | { kind: 'done'; outcome: TicketOutcome }
  | { kind: 'refused' | 'unknown' | 'failed'; message: string }

interface Op {
  /** The account the page showed when Isaac acted; retries keep it. */
  viewerId: string
  mutation: TicketMutation
  opId: string
  confirm: boolean
  approvalId: string | null
}

const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function prepare(op: Op): Promise<Step> {
  const r = await invoke('tickets.prepare', { viewerId: op.viewerId, mutation: op.mutation })
  if (!r.ok) return { kind: 'failed', message: r.error.message }
  if (r.value.source !== 'host') return { kind: 'failed', message: r.value.message }
  if (r.value.refused) return { kind: 'refused', message: r.value.refused.message }
  const { id, expiresAt: _expires, ...approval } = TicketApproval.parse(r.value.approval)
  return { kind: 'approval', id, approval }
}

async function commit(op: Op): Promise<Step> {
  const { viewerId, opId, mutation, approvalId } = op
  const r = await invoke('tickets.commit', {
    viewerId,
    opId,
    mutation,
    ...(approvalId ? { approvalId } : {}),
  })
  if (!r.ok) return { kind: 'failed', message: r.error.message }
  // No answer came back (timed out, disconnected): it may have been written.
  if (r.value.source !== 'host') return { kind: 'unknown', message: CHECKING }
  if (r.value.refused) return { kind: 'refused', message: r.value.refused.message }
  const outcome = TicketOutcome.parse(r.value.outcome)
  if (outcome.state === 'done') return { kind: 'done', outcome }
  if (outcome.state === 'unknown') return { kind: 'unknown', message: CHECKING }
  return { kind: 'failed', message: outcome.result?.error ?? 'Linear didn’t take it.' }
}

export interface TicketMutationHook {
  view: MutationView
  /** Mints the opId; prepare (confirmed kinds, or `confirm: true`) then commit. */
  run(m: TicketMutation, opts?: { confirm?: boolean }): void
  confirm(): void
  /** Drops a confirm or a finished state; a write already on its way is not dropped. */
  cancel(): void
  /** Again with the same opId: after `unknown` the same commit, after a refusal or failure from the start. */
  retry(): void
}

/** `viewerId`: the Linear account the page shows (`tickets.status` identity); null sends nothing. */
export function useTicketMutation(
  viewerId: string | null,
  onDone?: (outcome: TicketOutcome) => void,
): TicketMutationHook {
  const [view, setView] = useState<MutationView>({ kind: 'idle' })
  const current = useRef<MutationView>(view)
  const op = useRef<Op | null>(null)
  const turn = useRef(0)
  const done = useRef(onDone)
  done.current = onDone
  const viewer = useRef(viewerId)
  viewer.current = viewerId

  const show = useCallback((v: MutationView) => {
    current.current = v
    setView(v)
  }, [])

  const settle = useCallback(
    (t: number, s: Step) => {
      if (t !== turn.current || !op.current) return
      if (s.kind === 'approval') {
        op.current.approvalId = s.id
        show({ kind: 'confirming', approval: s.approval })
      } else if (s.kind === 'done') {
        show({ kind: 'done' })
        done.current?.(s.outcome)
      } else show(s)
    },
    [show],
  )

  const step = useCallback(
    (o: Op, phase: 'preparing' | 'committing') => {
      const t = turn.current
      show({ kind: phase })
      const p = phase === 'preparing' ? prepare(o) : commit(o)
      void p.then(
        (s) => settle(t, s),
        (e: unknown) =>
          settle(t, {
            kind: phase === 'preparing' ? 'failed' : 'unknown',
            message: phase === 'preparing' ? errorOf(e) : CHECKING,
          }),
      )
    },
    [settle, show],
  )

  const start = useCallback(
    (o: Op) => step(o, o.confirm && !o.approvalId ? 'preparing' : 'committing'),
    [step],
  )

  const run = useCallback(
    (mutation: TicketMutation, opts?: { confirm?: boolean }) => {
      turn.current += 1
      const id = viewer.current
      if (id === null) {
        op.current = null
        show({ kind: 'refused', message: NO_ACCOUNT })
        return
      }
      const confirm = ticketMutationConfirmed(mutation) || opts?.confirm === true
      op.current = { viewerId: id, mutation, opId: crypto.randomUUID(), confirm, approvalId: null }
      start(op.current)
    },
    [show, start],
  )

  const confirm = useCallback(() => {
    if (current.current.kind === 'confirming' && op.current) step(op.current, 'committing')
  }, [step])

  const cancel = useCallback(() => {
    if (current.current.kind === 'committing') return
    turn.current += 1
    op.current = null
    show({ kind: 'idle' })
  }, [show])

  const retry = useCallback(() => {
    const o = op.current
    const kind = current.current.kind
    if (!o || (kind !== 'unknown' && kind !== 'refused' && kind !== 'failed')) return
    turn.current += 1
    // A refusal or failure needs a fresh approval; a lost answer asks about the same commit.
    if (kind !== 'unknown') o.approvalId = null
    start(o)
  }, [start])

  return { view, run, confirm, cancel, retry }
}
