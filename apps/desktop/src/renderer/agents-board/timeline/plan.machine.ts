import { assign, fromPromise, setup } from 'xstate'
import type { DraftRow } from './plan-rules'

/**
 * The Timeline's plan draft (docs/state-machines/timeline-plan.md, PLAN T7.3). Nothing is written
 * until Isaac confirms Apply. Manual edits (drag, resize, reorder) and Astra's re-plan both build
 * draft rows; each row carries its own opId (minted once, reused by every retry) and the ticket's
 * `updatedAt` it was made from. Apply writes the Linear rows through the gate (prepare, then
 * commit with the approval) and saves start-only rows as Relay-only starts. Rows whose ticket
 * changed meanwhile make the draft `stale`: Isaac reviews the re-based draft and confirms again.
 * Failed rows stay in the draft with their errors; a retry sends them again with the same opIds.
 * The runtime (plan-actor.ts) provides the actors.
 */

export interface ReplanScope {
  projectId: string
  milestoneId?: string
  label: string
}

/** Astra's proposal as draft rows; null: the answer was not a readable plan. */
export type ReplanOutput = { rows: DraftRow[]; summary: string } | null

export interface RowResult {
  key: string
  state: 'done' | 'failed' | 'unknown'
  error?: string
}

export type ApplyOutput =
  /** Every row's outcome. */
  | { kind: 'done'; results: RowResult[] }
  /** These tickets changed since the draft: nothing was written. */
  | { kind: 'stale'; keys: string[] }
  /** The gate said no (writes off, identity): nothing was written. */
  | { kind: 'refused'; message: string }

export interface ApplyInput {
  rows: DraftRow[]
  /** The commit's own opId: kept while the same rows are retried after a lost answer. */
  opId: string
}

export type PlanEvent =
  /** The draft after a manual edit (plan-rules editRows); empty: nothing left to change. */
  | { type: 'plan.edit'; rows: DraftRow[] }
  /** Ask Astra to re-plan a project or milestone. */
  | { type: 'plan.replan'; scope: ReplanScope }
  /** Stop waiting for Astra. */
  | { type: 'plan.cancel' }
  /** Open the confirm listing every change. */
  | { type: 'plan.apply' }
  /** Close the confirm without writing. */
  | { type: 'plan.back' }
  /** Isaac confirmed: write. */
  | { type: 'plan.confirm' }
  /** Send the failed rows again (same opIds). */
  | { type: 'plan.retry' }
  /** The draft re-based on the tickets as they are now (plan-rules rebaseRows). */
  | { type: 'plan.reconfirm'; rows: DraftRow[] }
  /** Throw the draft away. */
  | { type: 'plan.discard' }
  /** Hide the "applied" note. */
  | { type: 'plan.dismiss' }

export interface PlanContext {
  rows: DraftRow[]
  source: 'manual' | 'astra'
  /** Astra's summary of its proposal. */
  summary: string | null
  /** One line for the UI (an unreadable answer, a refusal, a lost answer). */
  message: string | null
  scope: ReplanScope | null
  /** The commit opId of the rows in flight; null: mint one on the next apply. */
  batchOpId: string | null
}

export const UNREADABLE_PLAN = "Couldn't read a plan from this answer"
export const STALE_ROW = 'Changed since this draft'

const EMPTY: PlanContext = {
  rows: [],
  source: 'manual',
  summary: null,
  message: null,
  scope: null,
  batchOpId: null,
}

/** Back from a re-plan or a refusal: the draft if there is one, else viewing. */
const BACK = [{ target: 'drafting', guard: 'hasRows' }, { target: 'viewing' }] as const

export const timelinePlanMachine = setup({
  types: { context: {} as PlanContext, events: {} as PlanEvent },
  actors: {
    replan: fromPromise<ReplanOutput, ReplanScope>(async () => null),
    apply: fromPromise<ApplyOutput, ApplyInput>(async () => ({ kind: 'done', results: [] })),
  },
  guards: {
    hasRows: ({ context }) => context.rows.length > 0,
    eventHasRows: ({ event }) =>
      (event.type === 'plan.edit' || event.type === 'plan.reconfirm') && event.rows.length > 0,
    fromAstra: ({ context }) => context.source === 'astra',
    /** Astra's answer wasn't a plan. */
    unreadable: (_, p: { output: ReplanOutput }) => p.output === null,
    /** Astra's plan changes nothing in scope. */
    noChanges: (_, p: { output: ReplanOutput }) => p.output?.rows.length === 0,
    /** A ticket changed since the draft: nothing was written. */
    isStale: (_, p: { output: ApplyOutput }) => p.output.kind === 'stale',
    /** The gate said no: nothing was written. */
    isRefused: (_, p: { output: ApplyOutput }) => p.output.kind === 'refused',
    allApplied: ({ context }, p: { output: ApplyOutput }) =>
      failedRows(context.rows, p.output).length === 0,
  },
  actions: {
    clear: assign(() => EMPTY),
    takeEdit: assign(({ event }) =>
      event.type === 'plan.edit'
        ? { rows: event.rows, source: 'manual' as const, message: null, batchOpId: null }
        : {},
    ),
    startReplan: assign(({ event }) =>
      event.type === 'plan.replan' ? { scope: event.scope, message: null } : {},
    ),
    takeReconfirm: assign(({ event }) =>
      event.type === 'plan.reconfirm' ? { rows: event.rows, message: null, batchOpId: null } : {},
    ),
    mintBatch: assign(({ context }) => ({
      batchOpId: context.batchOpId ?? crypto.randomUUID(),
      message: null,
    })),
  },
}).createMachine({
  id: 'timelinePlan',
  context: EMPTY,
  initial: 'viewing',
  states: {
    viewing: {
      on: {
        'plan.edit': { target: 'drafting', guard: 'eventHasRows', actions: 'takeEdit' },
        'plan.replan': { target: 'replanning', actions: 'startReplan' },
      },
    },
    drafting: {
      on: {
        'plan.edit': [
          { target: 'drafting', guard: 'eventHasRows', actions: 'takeEdit' },
          { target: 'viewing', actions: 'clear' },
        ],
        'plan.replan': { target: 'replanning', actions: 'startReplan' },
        'plan.apply': { target: 'confirming', guard: 'hasRows' },
        'plan.discard': { target: 'viewing', actions: 'clear' },
      },
    },
    replanning: {
      invoke: {
        src: 'replan',
        input: ({ context }) => context.scope!,
        onDone: [
          {
            guard: { type: 'unreadable', params: ({ event }) => ({ output: event.output }) },
            target: 'back',
            actions: assign({ message: UNREADABLE_PLAN }),
          },
          {
            guard: { type: 'noChanges', params: ({ event }) => ({ output: event.output }) },
            target: 'back',
            actions: assign({
              message: ({ event }) => event.output!.summary || 'No changes suggested',
            }),
          },
          {
            target: 'reviewingProposal',
            actions: assign(({ event }) => ({
              rows: event.output!.rows,
              summary: event.output!.summary,
              source: 'astra' as const,
              batchOpId: null,
            })),
          },
        ],
        onError: {
          target: 'back',
          actions: assign({ message: ({ event }) => errorText(event.error) }),
        },
      },
      on: { 'plan.cancel': 'back' },
    },
    /** Leaves a re-plan (or refusal) for the draft, if any, else viewing. */
    back: { always: [...BACK] },
    reviewingProposal: {
      on: {
        'plan.edit': [
          { target: 'drafting', guard: 'eventHasRows', actions: 'takeEdit' },
          { target: 'viewing', actions: 'clear' },
        ],
        'plan.replan': { target: 'replanning', actions: 'startReplan' },
        'plan.apply': 'confirming',
        'plan.discard': { target: 'viewing', actions: 'clear' },
      },
    },
    confirming: {
      on: {
        'plan.confirm': 'applying',
        'plan.back': [{ target: 'reviewingProposal', guard: 'fromAstra' }, { target: 'drafting' }],
      },
    },
    applying: {
      entry: 'mintBatch',
      invoke: {
        src: 'apply',
        input: ({ context }) => ({ rows: context.rows, opId: context.batchOpId! }),
        onDone: [
          {
            guard: { type: 'isStale', params: ({ event }) => ({ output: event.output }) },
            target: 'stale',
            actions: assign({
              rows: ({ context, event }) => markStale(context.rows, event.output),
            }),
          },
          {
            guard: { type: 'isRefused', params: ({ event }) => ({ output: event.output }) },
            target: 'back',
            actions: assign({
              message: ({ event }) =>
                event.output.kind === 'refused' ? event.output.message : null,
            }),
          },
          {
            guard: { type: 'allApplied', params: ({ event }) => ({ output: event.output }) },
            target: 'applied',
            actions: 'clear',
          },
          {
            target: 'partiallyFailed',
            actions: assign(({ context, event }) => ({
              rows: failedRows(context.rows, event.output),
              batchOpId: null,
            })),
          },
        ],
        onError: {
          target: 'partiallyFailed',
          actions: assign({ message: ({ event }) => errorText(event.error) }),
        },
      },
    },
    applied: {
      on: {
        'plan.edit': { target: 'drafting', guard: 'eventHasRows', actions: 'takeEdit' },
        'plan.replan': { target: 'replanning', actions: 'startReplan' },
        'plan.dismiss': 'viewing',
      },
    },
    partiallyFailed: {
      on: {
        'plan.retry': 'confirming',
        'plan.edit': [
          { target: 'drafting', guard: 'eventHasRows', actions: 'takeEdit' },
          { target: 'viewing', actions: 'clear' },
        ],
        'plan.discard': { target: 'viewing', actions: 'clear' },
      },
    },
    stale: {
      on: {
        'plan.reconfirm': [
          { target: 'confirming', guard: 'eventHasRows', actions: 'takeReconfirm' },
          { target: 'viewing', actions: 'clear' },
        ],
        'plan.discard': { target: 'viewing', actions: 'clear' },
      },
    },
  },
})

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function markStale(rows: readonly DraftRow[], out: ApplyOutput): DraftRow[] {
  const keys = new Set(out.kind === 'stale' ? out.keys : [])
  return rows.map((r) => (keys.has(r.key) ? { ...r, stale: true, error: STALE_ROW } : r))
}

/** The rows whose write did not succeed, with their errors (done rows leave the draft). */
function failedRows(rows: readonly DraftRow[], out: ApplyOutput): DraftRow[] {
  const results = new Map(out.kind === 'done' ? out.results.map((r) => [r.key, r]) : [])
  return rows
    .filter((r) => results.get(r.key)?.state !== 'done')
    .map((r) => ({ ...r, error: results.get(r.key)?.error ?? 'Not written' }))
}
