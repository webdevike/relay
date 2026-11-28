// One generic lifecycle for every ticket write through the host's gate (PLAN §2.5, §6): a confirmed
// kind is `prepare`d, shown to Isaac (`confirming`) and committed with the approval; others commit
// at once. The opId is minted once per `run` and reused by `retry`, so a lost answer never writes
// twice: the host answers the stored outcome (or reconciles) instead.
import { useCallback, useRef, useState } from 'react'
import {
  TicketApproval,
  TicketOutcome,
  ticketMutationConfirmed,
  type TicketMutation,
} from '@relay/protocol'
import { invoke } from '../ipc'

export type MutationView =
  | { kind: 'idle' }
  | { kind: 'preparing' | 'committing' }
  /** The UI shows an EvaModal with the exact text and this summary; confirm() commits. */
  | { kind: 'confirming'; summary: string }
  | { kind: 'done' }
  | { kind: 'refused'; message: string }
  /** The answer was lost: it may or may not have been written. retry() asks again (same opId). */
  | { kind: 'unknown'; message: string }
  | { kind: 'failed'; message: string }

export const CHECKING = 'Checking whether it posted'

type Step =
  | { kind: 'approval'; id: string; summary: string }
  | { kind: 'done'; outcome: TicketOutcome }
  | { kind: 'refused' | 'unknown' | 'failed'; message: string }

interface Op {
  mutation: TicketMutation
  opId: string
  confirm: boolean
  approvalId: string | null
}

const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function prepare(mutation: TicketMutation): Promise<Step> {
  const r = await invoke('tickets.prepare', { mutation })
  if (!r.ok) return { kind: 'failed', message: r.error.message }
  if (r.value.source !== 'host') return { kind: 'failed', message: r.value.message }
  if (r.value.refused) return { kind: 'refused', message: r.value.refused.message }
  const approval = TicketApproval.parse(r.value.approval)
  return { kind: 'approval', id: approval.id, summary: approval.summary }
}

async function commit(op: Op): Promise<Step> {
  const { opId, mutation, approvalId } = op
  const r = await invoke('tickets.commit', {
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

export function useTicketMutation(onDone?: (outcome: TicketOutcome) => void): TicketMutationHook {
  const [view, setView] = useState<MutationView>({ kind: 'idle' })
  const current = useRef<MutationView>(view)
  const op = useRef<Op | null>(null)
  const turn = useRef(0)
  const done = useRef(onDone)
  done.current = onDone

  const show = useCallback((v: MutationView) => {
    current.current = v
    setView(v)
  }, [])

  const settle = useCallback(
    (t: number, s: Step) => {
      if (t !== turn.current || !op.current) return
      if (s.kind === 'approval') {
        op.current.approvalId = s.id
        show({ kind: 'confirming', summary: s.summary })
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
      const p = phase === 'preparing' ? prepare(o.mutation) : commit(o)
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
      const confirm = ticketMutationConfirmed(mutation) || opts?.confirm === true
      op.current = { mutation, opId: crypto.randomUUID(), confirm, approvalId: null }
      start(op.current)
    },
    [start],
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
