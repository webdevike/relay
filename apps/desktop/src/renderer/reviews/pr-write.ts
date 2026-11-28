// One PR write through the host's gate (PLAN §2.5, §5): `reviews.prPrepare` for a confirmed kind
// (comment, review comment, reply, request review, merge), shown to Isaac (`confirming`), then
// `reviews.prCommit` with the approval; unconfirmed kinds (reaction, re-run) commit at once. The
// opId is minted once per `run` and reused by `retry`, so a lost answer never writes twice. Merge
// has its own machine (pr-merge.machine.ts); this is the generic lifecycle for the rest, the same
// views as the ticket page's `useTicketMutation`.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  TicketApproval,
  TicketOutcome,
  TicketsStatus,
  prMutationConfirmed,
  type GithubReaction,
  type PrMutation,
} from '@relay/protocol'
import type { PrActionAnswer, ReviewPr } from '@evaos/contract'
import { invoke } from '../ipc'
import { CHECKING, type MutationView } from '../tickets/use-mutation'

export type { MutationView } from '../tickets/use-mutation'

/** The PR's writes go through the host gate: the host read it with `actions` facts (a host with `reviews.actions`). */
export function prWritesOn(pr: ReviewPr): boolean {
  return pr.actions !== undefined && pr.headSha !== undefined
}

/** The reactions GitHub has, as the host reads them (unicode), with GitHub's name for each. */
export const GITHUB_REACTION: Readonly<Record<string, GithubReaction>> = {
  '👍': '+1',
  '👎': '-1',
  '😄': 'laugh',
  '🎉': 'hooray',
  '😕': 'confused',
  '❤️': 'heart',
  '🚀': 'rocket',
  '👀': 'eyes',
}

let login: Promise<string | null> | null = null

/** The GitHub login the host's gate acts as (its `tickets.status` identity), asked once; null when unknown. */
export function useGithubLogin(): string | null {
  const [me, setMe] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    login ??= invoke('tickets.board', {}).then((r) => {
      if (!r.ok || r.value.source !== 'host') return null
      const status = TicketsStatus.safeParse(r.value.status)
      return status.success ? (status.data.identity.github?.login ?? null) : null
    })
    void login.then((l) => {
      // Not known yet (host not connected, no gh login): the next page asks again.
      if (l === null) login = null
      if (live) setMe(l)
    })
    return () => {
      live = false
    }
  }, [])
  return me
}

export type PrStep =
  | { kind: 'approval'; id: string; summary: string }
  | { kind: 'done'; outcome: TicketOutcome }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'unknown' | 'failed'; message: string }

const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type HostAnswer = Extract<PrActionAnswer, { source: 'host' }>

/** The host's answer, or the step it already decides: no host to ask, or the gate's refusal. */
function hostAnswer(a: PrActionAnswer): HostAnswer | PrStep {
  if ('unavailable' in a) return { kind: 'failed', message: a.unavailable }
  if (a.refused) return { kind: 'refused', code: a.refused.code, message: a.refused.message }
  return a
}

export async function prPrepare(mutation: PrMutation): Promise<PrStep> {
  const r = await invoke('reviews.prPrepare', { mutation })
  if (!r.ok) return { kind: 'failed', message: r.error.message }
  const a = hostAnswer(r.value)
  if ('kind' in a) return a
  if (!a.approval) return { kind: 'failed', message: a.error ?? 'The host could not check GitHub.' }
  const approval = TicketApproval.parse(a.approval)
  return { kind: 'approval', id: approval.id, summary: approval.summary }
}

export async function prCommit(input: {
  opId: string
  approvalId: string | null
  mutation: PrMutation
}): Promise<PrStep> {
  const { opId, approvalId, mutation } = input
  const r = await invoke('reviews.prCommit', {
    opId,
    mutation,
    ...(approvalId ? { approvalId } : {}),
  })
  // No answer came back (timed out, disconnected): it may have been written.
  if (!r.ok) return { kind: 'unknown', message: CHECKING }
  const a = hostAnswer(r.value)
  if ('kind' in a) return a
  const outcome = TicketOutcome.safeParse(a.outcome)
  if (!outcome.success) return { kind: 'failed', message: a.error ?? 'GitHub didn’t take it.' }
  const o = outcome.data
  if (o.state === 'done') return { kind: 'done', outcome: o }
  if (o.state === 'unknown') return { kind: 'unknown', message: CHECKING }
  return { kind: 'failed', message: o.result?.error ?? 'GitHub didn’t take it.' }
}

interface Op {
  mutation: PrMutation
  opId: string
  approvalId: string | null
}

export interface PrWrite {
  view: MutationView
  /** Mints the opId; prepare (confirmed kinds) then commit. */
  run(m: PrMutation): void
  confirm(): void
  /** Drops a confirm or a finished state; a write already on its way is not dropped. */
  cancel(): void
  /** Again with the same opId: after `unknown` the same commit, after a refusal or failure a fresh approval. */
  retry(): void
}

export function usePrWrite(onDone?: (outcome: TicketOutcome, m: PrMutation) => void): PrWrite {
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
    (t: number, s: PrStep) => {
      const o = op.current
      if (t !== turn.current || !o) return
      if (s.kind === 'approval') {
        o.approvalId = s.id
        show({ kind: 'confirming', summary: s.summary })
      } else if (s.kind === 'done') {
        show({ kind: 'done' })
        done.current?.(s.outcome, o.mutation)
      } else show({ kind: s.kind, message: s.message })
    },
    [show],
  )

  const step = useCallback(
    (o: Op, phase: 'preparing' | 'committing') => {
      const t = turn.current
      show({ kind: phase })
      const p = phase === 'preparing' ? prPrepare(o.mutation) : prCommit(o)
      void p.then(
        (s) => settle(t, s),
        (e: unknown) =>
          settle(
            t,
            phase === 'preparing'
              ? { kind: 'failed', message: errorOf(e) }
              : { kind: 'unknown', message: CHECKING },
          ),
      )
    },
    [settle, show],
  )

  const start = useCallback(
    (o: Op) =>
      step(o, prMutationConfirmed(o.mutation) && !o.approvalId ? 'preparing' : 'committing'),
    [step],
  )

  const run = useCallback(
    (mutation: PrMutation) => {
      turn.current += 1
      op.current = { mutation, opId: crypto.randomUUID(), approvalId: null }
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
    if (kind !== 'unknown') o.approvalId = null
    start(o)
  }, [start])

  return { view, run, confirm, cancel, retry }
}
