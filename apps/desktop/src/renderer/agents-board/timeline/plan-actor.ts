import { useRef, useState } from 'react'
import { useActorRef, useSelector } from '@xstate/react'
import { fromPromise, type SnapshotFrom } from 'xstate'
import {
  TicketApproval,
  TicketOutcome,
  TicketPlanProposal,
  TicketsBoard,
  type TicketMutation,
} from '@relay/protocol'
import type { Result, TicketsFallback } from '@evaos/contract'
import { invoke } from '../../ipc'
import { boardViewerId } from '../card-move-actor'
import {
  editRows,
  proposalRows,
  staleKeys,
  toPlanRow,
  type DraftRow,
  type PlanFields,
  type PlanTicket,
} from './plan-rules'
import {
  timelinePlanMachine,
  type ApplyInput,
  type ApplyOutput,
  type PlanEvent,
  type ReplanOutput,
  type ReplanScope,
  type RowResult,
} from './plan.machine'

/** The host can't do it yet (no `tickets.replan` route). */
export const NEEDS_NEWER_HOST = 'Needs a newer Relay host'
const LOST_ROW = 'Linear didn’t answer for this row. Check again: it is never sent twice.'
/** Astra's proposal was read as another Linear account than the Board shows. */
export const OTHER_ACCOUNT =
  'This plan was made for another Linear account than the Board shows. Ask Astra again.'

type Refused = { refused: { code: string; message: string } }

/** The runtime's effects; tests and the integrator provide them. */
export interface PlanDeps {
  /** The tickets as the host has them now (the stale check before writing). */
  current(): Promise<readonly PlanTicket[]>
  /** The Linear account the Board shows (writes carry it; a proposal must be for it). */
  viewerId(): string
  /** The gate's approval: its id and the rows it writes, by the issues' live keys (host-resolved). */
  prepare(mutation: TicketMutation): Promise<{ approvalId: string; keys: string[] } | Refused>
  /** The write; without `approvalId` it only answers a batch the host already has (Check). */
  commit(input: {
    approvalId?: string
    opId: string
    mutation: TicketMutation
  }): Promise<{ outcome: TicketOutcome } | Refused>
  /** Astra's re-plan answer (a TicketPlanProposal, unchecked). Absent: the host can't. */
  replan?: (scope: { projectId: string; milestoneId?: string }) => Promise<unknown>
}

/** The host's answer, or why there is none, as an error. */
async function host<T extends { source: string }>(
  answer: Promise<Result<T>>,
): Promise<Exclude<T, TicketsFallback>> {
  const r = await answer
  if (!r.ok) throw new Error(r.error.message)
  if (r.value.source === 'host') return r.value as Exclude<T, TicketsFallback>
  const why = 'message' in r.value ? r.value.message : null
  throw new Error(typeof why === 'string' ? why : 'Linear sync needs the Relay Host.')
}

export const LIVE_PLAN_DEPS: PlanDeps = {
  current: async () => TicketsBoard.parse((await host(invoke('tickets.board', {}))).board).tickets,
  viewerId: boardViewerId,
  prepare: async (mutation) => {
    const r = await host(invoke('tickets.prepare', { viewerId: boardViewerId(), mutation }))
    if (r.refused) return { refused: r.refused }
    const approval = TicketApproval.parse(r.approval)
    return { approvalId: approval.id, keys: (approval.rows ?? []).map((row) => row.key) }
  },
  commit: async (input) => {
    const r = await host(invoke('tickets.commit', { viewerId: boardViewerId(), ...input }))
    return r.refused ? { refused: r.refused } : { outcome: TicketOutcome.parse(r.outcome) }
  },
  // `invalid`: Astra's answer wasn't a readable plan (the machine says so); other refusals throw.
  replan: async (scope) => {
    const r = await host(invoke('tickets.replan', scope))
    if (r.refused && r.refused.code !== 'invalid') throw new Error(r.refused.message)
    return r.refused ? null : r.proposal
  },
}

function refusal(r: Refused['refused'], rows: readonly DraftRow[]): ApplyOutput {
  if (r.code === 'conflict') return { kind: 'stale', keys: rows.map((x) => x.key) }
  return { kind: 'refused', message: r.message }
}

function rowResults(rows: readonly DraftRow[], outcome: TicketOutcome): RowResult[] {
  const per = new Map((outcome.result?.rows ?? []).map((r) => [r.opId, r]))
  return rows.map((row) => {
    const one = per.get(row.opId)
    const state = one?.state ?? outcome.state
    if (state === 'done') return { key: row.key, state }
    const lost = state === 'unknown' ? LOST_ROW : 'Linear didn’t take it.'
    return { key: row.key, state, error: one?.error ?? outcome.result?.error ?? lost }
  })
}

/** The host would write other rows than the draft Isaac reviewed: nothing is committed. */
export const OTHER_ROWS =
  'The host would write other tickets than this draft; nothing was written. Review it again.'

/** Whether the gate's rows (live keys) are exactly the drafted ones. */
function sameRows(rows: readonly DraftRow[], keys: readonly string[]): boolean {
  const want = new Set(rows.map((r) => r.key))
  return keys.length === want.size && keys.every((k) => want.has(k))
}

const planOf = (rows: readonly DraftRow[]): TicketMutation => ({
  kind: 'applyPlan',
  rows: rows.map(toPlanRow),
})

/**
 * Apply: every row (Linear fields and Relay-only starts) as one `applyPlan` batch: nothing is
 * written when a ticket changed since the draft; else prepare, check the host's rows, commit with
 * the approval. The host saves each row's start only once its Linear part is done.
 */
export async function applyRows(input: ApplyInput, deps: PlanDeps): Promise<ApplyOutput> {
  const stale = staleKeys(input.rows, await deps.current())
  if (stale.length > 0) return { kind: 'stale', keys: stale }
  const mutation = planOf(input.rows)
  const approval = await deps.prepare(mutation)
  if ('refused' in approval) return refusal(approval.refused, input.rows)
  if (!sameRows(input.rows, approval.keys)) return { kind: 'refused', message: OTHER_ROWS }
  const done = await deps.commit({ approvalId: approval.approvalId, opId: input.opId, mutation })
  if ('refused' in done) return refusal(done.refused, input.rows)
  return { kind: 'done', results: rowResults(input.rows, done.outcome) }
}

/**
 * Check a batch whose outcome is unknown: the same commit (same batch and row opIds), no approval.
 * The host answers its stored outcome or reconciles unknown rows with Linear; it never sends them
 * again. A host with no record of it refuses for a confirm: nothing was written (`unsent`).
 */
export async function checkRows(input: ApplyInput, deps: PlanDeps): Promise<ApplyOutput> {
  const done = await deps.commit({ opId: input.opId, mutation: planOf(input.rows) })
  if (!('refused' in done)) return { kind: 'done', results: rowResults(input.rows, done.outcome) }
  if (done.refused.code === 'approval') return { kind: 'unsent' }
  return { kind: 'refused', message: done.refused.message }
}

const mint = (): string => crypto.randomUUID()

/**
 * Astra's answer as draft rows against the host's baseline; null: unreadable. A proposal read as
 * another account than the Board shows is refused.
 */
export async function replanRows(
  scope: ReplanScope,
  deps: PlanDeps,
  newId: () => string = mint,
): Promise<ReplanOutput> {
  if (!deps.replan) throw new Error(NEEDS_NEWER_HOST)
  const { projectId, milestoneId } = scope
  const raw = await deps.replan(milestoneId ? { projectId, milestoneId } : { projectId })
  const parsed = TicketPlanProposal.safeParse(raw)
  if (!parsed.success || !parsed.data.baseline) return null
  if (parsed.data.viewerId !== deps.viewerId()) throw new Error(OTHER_ACCOUNT)
  const rows = proposalRows(parsed.data, await deps.current(), newId)
  return { rows, summary: parsed.data.summary }
}

export type PlanSnapshot = SnapshotFrom<typeof timelinePlanMachine>

export interface PlanHandle {
  snap: PlanSnapshot
  send(event: PlanEvent): void
  /** Merge a manual edit into the draft. */
  edit(t: PlanTicket, patch: Partial<PlanFields>): void
  canReplan: boolean
}

const selectSnap = (s: PlanSnapshot): PlanSnapshot => s

/** The Timeline's plan draft; `deps` overrides the live effects (the host routes, tests). */
export function usePlan(deps?: Partial<PlanDeps>): PlanHandle {
  const live = useRef<PlanDeps>(LIVE_PLAN_DEPS)
  live.current = { ...LIVE_PLAN_DEPS, ...deps }
  const [machine] = useState(() =>
    timelinePlanMachine.provide({
      actors: {
        replan: fromPromise(({ input }) => replanRows(input, live.current)),
        apply: fromPromise(({ input }) => applyRows(input, live.current)),
        check: fromPromise(({ input }) => checkRows(input, live.current)),
      },
    }),
  )
  const actor = useActorRef(machine)
  const snap = useSelector(actor, selectSnap)
  return {
    snap,
    send: (event) => actor.send(event),
    edit: (t, patch) =>
      actor.send({
        type: 'plan.edit',
        rows: editRows(actor.getSnapshot().context.rows, t, patch, mint),
      }),
    canReplan: Boolean(live.current.replan),
  }
}
