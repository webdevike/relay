// One PR write through the host's gate (PLAN §2.5, §5): `reviews.prPrepare` for a confirmed kind
// (comment, review comment, reply, request review, merge), shown to Isaac (`confirming`, the host's
// approval in full), then `reviews.prCommit` with the approval; unconfirmed kinds (reaction, re-run)
// commit at once. Every op carries the gh login the page's PR read showed (`actions.viewerLogin`);
// the host refuses when it acts as another. The opId is minted once per `run` and reused by
// `retry`, so a lost answer never writes twice. Merge has its own machine (pr-merge.machine.ts).
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  TicketApproval,
  TicketOutcome,
  TicketsStatus,
  prMutationConfirmed,
  type GithubReaction,
  type PrMutation,
  type TicketConfirm,
} from '@relay/protocol'
import type { PrActionAnswer, ReviewPr } from '@evaos/contract'
import { invoke } from '../ipc'
import { CHECKING, type MutationView } from '../tickets/use-mutation'

export type { MutationView } from '../tickets/use-mutation'

/** The PR's writes go through the host gate: the host read it with `actions` facts (a host with `reviews.actions`). */
export function prWritesOn(pr: ReviewPr): boolean {
  return pr.actions !== undefined && pr.headSha !== undefined
}

/**
 * How a comment on this PR is written, by the HOST'S capability when main read it (`writeGate`),
 * never by whether the facts happen to be there (PLAN §2.9): `gate` through the host's gate;
 * `unavailable` when that host couldn't give this read its facts (a failed query, a newer head):
 * refused until a re-read has them, never downgraded; `legacy` the confirmed `reviews.comment`
 * only without such a host (old host, disconnected, flags off).
 */
export function prWritePath(pr: ReviewPr): 'gate' | 'unavailable' | 'legacy' {
  if (prWritesOn(pr)) return 'gate'
  return pr.writeGate ? 'unavailable' : 'legacy'
}

/** A capable host's read came without its facts: what Isaac is told before he retries (a re-read). */
export const PR_ACTIONS_STALE =
  'PR actions unavailable: Relay Host couldn’t confirm this pull request’s current state. Retry reads it again.'

/** The gh login the page's PR read showed; writes carry it. */
export const prLoginOf = (pr: ReviewPr): string | null => pr.actions?.viewerLogin ?? null

/** No gh login on the page (an older read): nothing is sent. */
export const NO_GITHUB_ACCOUNT =
  'The host hasn’t said which GitHub account it writes as. Reload the pull request and try again.'

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
  | { kind: 'approval'; id: string; approval: TicketConfirm }
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

export async function prPrepare(mutation: PrMutation, login: string): Promise<PrStep> {
  const r = await invoke('reviews.prPrepare', { login, mutation })
  if (!r.ok) return { kind: 'failed', message: r.error.message }
  const a = hostAnswer(r.value)
  if ('kind' in a) return a
  if (!a.approval) return { kind: 'failed', message: a.error ?? 'The host could not check GitHub.' }
  const { id, expiresAt: _expires, ...approval } = TicketApproval.parse(a.approval)
  return { kind: 'approval', id, approval }
}

export async function prCommit(input: {
  login: string
  opId: string
  approvalId: string | null
  mutation: PrMutation
}): Promise<PrStep> {
  const { login, opId, approvalId, mutation } = input
  const r = await invoke('reviews.prCommit', {
    login,
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
  /** The gh login the page showed when Isaac acted; retries keep it. */
  login: string
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

/** `login`: the gh login the page shows (`prLoginOf`); null sends nothing. */
export function usePrWrite(
  login: string | null,
  onDone?: (outcome: TicketOutcome, m: PrMutation) => void,
): PrWrite {
  const [view, setView] = useState<MutationView>({ kind: 'idle' })
  const current = useRef<MutationView>(view)
  const op = useRef<Op | null>(null)
  const turn = useRef(0)
  const done = useRef(onDone)
  done.current = onDone
  const who = useRef(login)
  who.current = login

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
        show({ kind: 'confirming', approval: s.approval })
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
      const p = phase === 'preparing' ? prPrepare(o.mutation, o.login) : prCommit(o)
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
      if (who.current === null) {
        op.current = null
        show({ kind: 'refused', message: NO_GITHUB_ACCOUNT })
        return
      }
      op.current = { login: who.current, mutation, opId: crypto.randomUUID(), approvalId: null }
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
    if (kind !== 'unknown') o.approvalId = null
    start(o)
  }, [start])

  return { view, run, confirm, cancel, retry }
}
