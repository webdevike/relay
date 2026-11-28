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
import {
  editRows,
  proposalRows,
  splitRows,
  staleKeys,
  toPlanRow,
  type Day,
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

/** The host can't do it yet (no `tickets.plan` / `tickets.replan` route). */
export const NEEDS_NEWER_HOST = 'Needs a newer Relay host'
const LOST_ANSWER = 'Linear didn’t answer. Retry is safe: nothing is written twice.'

type Refused = { refused: { code: string; message: string } }

/** The runtime's effects; tests and the integrator provide them. */
export interface PlanDeps {
  /** The tickets as the host has them now (the stale check before writing, Astra's baseline). */
  current(): Promise<readonly PlanTicket[]>
  prepare(mutation: TicketMutation): Promise<{ approvalId: string } | Refused>
  commit(input: {
    approvalId: string
    opId: string
    mutation: TicketMutation
  }): Promise<{ outcome: TicketOutcome } | Refused>
  /** Relay-only starts (host `plan.json`); rejects with the reason. Absent: the host can't. */
  savePlannedStarts?: (rows: { key: string; plannedStart: Day | null }[]) => Promise<void>
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
  prepare: async (mutation) => {
    const r = await host(invoke('tickets.prepare', { mutation }))
    return r.refused ? { refused: r.refused } : { approvalId: TicketApproval.parse(r.approval).id }
  },
  commit: async (input) => {
    const r = await host(invoke('tickets.commit', input))
    return r.refused ? { refused: r.refused } : { outcome: TicketOutcome.parse(r.outcome) }
  },
}

function refusal(r: Refused['refused'], rows: readonly DraftRow[]): ApplyOutput {
  if (r.code === 'conflict') return { kind: 'stale', keys: rows.map((x) => x.key) }
  return { kind: 'refused', message: r.message }
}

function rowResults(rows: readonly DraftRow[], outcome: TicketOutcome): RowResult[] {
  const per = new Map((outcome.result?.rows ?? []).map((r) => [r.key, r]))
  return rows.map((row) => {
    const one = per.get(row.key)
    const state = one?.state ?? outcome.state
    if (state === 'done') return { key: row.key, state }
    const lost = state === 'unknown' ? LOST_ANSWER : 'Linear didn’t take it.'
    return { key: row.key, state, error: one?.error ?? outcome.result?.error ?? lost }
  })
}

/** The Linear rows as one `applyPlan` write: prepare, then commit with the approval. */
async function writeLinear(rows: DraftRow[], opId: string, deps: PlanDeps): Promise<ApplyOutput> {
  const mutation: TicketMutation = { kind: 'applyPlan', rows: rows.map(toPlanRow) }
  const approval = await deps.prepare(mutation)
  if ('refused' in approval) return refusal(approval.refused, rows)
  const done = await deps.commit({ approvalId: approval.approvalId, opId, mutation })
  if ('refused' in done) return refusal(done.refused, rows)
  return { kind: 'done', results: rowResults(rows, done.outcome) }
}

/** Start-only rows: Relay-only, no Linear write. */
async function saveStarts(rows: DraftRow[], deps: PlanDeps): Promise<RowResult[]> {
  const fail = (error: string): RowResult[] =>
    rows.map((r) => ({ key: r.key, state: 'failed', error }))
  if (!deps.savePlannedStarts) return fail(NEEDS_NEWER_HOST)
  try {
    await deps.savePlannedStarts(
      rows.map((r) => ({ key: r.key, plannedStart: r.plannedStart ?? null })),
    )
    return rows.map((r) => ({ key: r.key, state: 'done' }))
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

/** Apply: nothing is written when a ticket changed since the draft. */
export async function applyRows(input: ApplyInput, deps: PlanDeps): Promise<ApplyOutput> {
  const stale = staleKeys(input.rows, await deps.current())
  if (stale.length > 0) return { kind: 'stale', keys: stale }
  const { linear, relayOnly } = splitRows(input.rows)
  const results: RowResult[] = []
  if (linear.length > 0) {
    const out = await writeLinear(linear, input.opId, deps)
    if (out.kind !== 'done') return out
    results.push(...out.results)
  }
  if (relayOnly.length > 0) results.push(...(await saveStarts(relayOnly, deps)))
  return { kind: 'done', results }
}

const mint = (): string => crypto.randomUUID()

/** Astra's answer as draft rows against the tickets at the time of asking; null: unreadable. */
export async function replanRows(
  scope: ReplanScope,
  deps: PlanDeps,
  newId: () => string = mint,
): Promise<ReplanOutput> {
  if (!deps.replan) throw new Error(NEEDS_NEWER_HOST)
  const tickets = await deps.current()
  const { projectId, milestoneId } = scope
  const raw = await deps.replan(milestoneId ? { projectId, milestoneId } : { projectId })
  const parsed = TicketPlanProposal.safeParse(raw)
  if (!parsed.success) return null
  const inScope = tickets.filter(
    (t) => t.project?.id === projectId && (!milestoneId || t.milestone?.id === milestoneId),
  )
  return { rows: proposalRows(parsed.data, inScope, newId), summary: parsed.data.summary }
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
