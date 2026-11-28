import { assign, fromPromise, setup } from 'xstate'
import type { DraftRow } from './plan-rules'

/**
 * The Timeline's plan draft (docs/state-machines/timeline-plan.md, PLAN T7.3). Nothing is written
 * until Isaac confirms Apply. Manual edits (drag, resize, reorder) and Astra's re-plan both build
 * draft rows; each row carries its own opId and the ticket's `updatedAt` and Relay start it was made
 * from. Apply writes every row (Linear fields and Relay-only starts alike) as one gate `applyPlan`
 * batch (prepare, then commit with the approval) under a batch opId. Rows whose ticket changed
 * meanwhile, or an Astra proposal the host found stale, make the draft `stale`: nothing applies
 * until Isaac has seen the re-based comparison and confirmed again. Definite failures stay in the
 * draft with their errors; a retry is a fresh confirm under a new batch opId (the host never sends a
 * row it already wrote again). When any row's outcome is unknown (or the answer was lost) the batch
 * is kept as it was sent: the only way on is Check (the same commit, same opIds, which the host
 * reconciles and never sends twice) or Discard; a batch the host never got goes back to the confirm.
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
  /** Check: the host has no record of this batch, so nothing was written; it needs a confirm. */
  | { kind: 'unsent' }

export interface ApplyInput {
  rows: DraftRow[]
  /** The batch's commit opId: kept while any of its rows' outcome is unknown. */
  opId: string
}

/** The batch as it was sent: Check resends exactly this, so the host answers its stored outcome. */
export interface PlanBatch {
  opId: string
  rows: DraftRow[]
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
  /** Confirm the definitely failed rows again (a new batch; the rows keep their opIds). */
  | { type: 'plan.retry' }
  /** Ask the host how the kept batch ended (the same commit; nothing is sent twice). */
  | { type: 'plan.check' }
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
  /** The batch in flight or with an unknown outcome; null: the next apply mints one. */
  batch: PlanBatch | null
}

export const UNREADABLE_PLAN = "Couldn't read a plan from this answer"
export const STALE_ROW = 'Changed since this draft'
export const LOST_ANSWER = 'No answer came back, so it may have been written. Check again.'
export const STILL_UNKNOWN =
  'Linear doesn’t show these changes yet. Check again later, or Discard and look in Linear.'

const EMPTY: PlanContext = {
  rows: [],
  source: 'manual',
  summary: null,
  message: null,
  scope: null,
  batch: null,
}

/** Back from a re-plan or a refusal: the draft if there is one, else viewing. */
const BACK = [{ target: 'drafting', guard: 'hasRows' }, { target: 'viewing' }] as const

type Out = { output: ApplyOutput }
const out = ({ event }: { event: { output: ApplyOutput } }): Out => ({ output: event.output })

export const timelinePlanMachine = setup({
  types: { context: {} as PlanContext, events: {} as PlanEvent },
  actors: {
    replan: fromPromise<ReplanOutput, ReplanScope>(async () => null),
    apply: fromPromise<ApplyOutput, ApplyInput>(async () => ({ kind: 'done', results: [] })),
    check: fromPromise<ApplyOutput, ApplyInput>(async () => ({ kind: 'unsent' })),
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
    /** Some of Astra's rows changed since her baseline: compare again before anything applies. */
    staleProposal: (_, p: { output: ReplanOutput }) =>
      p.output?.rows.some((r) => r.stale === true) === true,
    /** A ticket changed since the draft: nothing was written. */
    isStale: (_, p: Out) => p.output.kind === 'stale',
    /** The gate said no: nothing was written. */
    isRefused: (_, p: Out) => p.output.kind === 'refused',
    /** The host never got the batch: nothing was written. */
    isUnsent: (_, p: Out) => p.output.kind === 'unsent',
    allApplied: ({ context }, p: Out) => openRows(sent(context), p.output).length === 0,
    anyUnknown: (_, p: Out) =>
      p.output.kind === 'done' && p.output.results.some((r) => r.state === 'unknown'),
  },
  actions: {
    clear: assign(() => EMPTY),
    takeEdit: assign(({ event }) =>
      event.type === 'plan.edit'
        ? { rows: event.rows, source: 'manual' as const, message: null, batch: null }
        : {},
    ),
    startReplan: assign(({ event }) =>
      event.type === 'plan.replan' ? { scope: event.scope, message: null } : {},
    ),
    takeReconfirm: assign(({ event }) =>
      event.type === 'plan.reconfirm' ? { rows: event.rows, message: null, batch: null } : {},
    ),
    takeProposal: assign((_, p: { output: ReplanOutput }) => ({
      rows: (p.output?.rows ?? []).map((r) => (r.stale ? { ...r, error: STALE_ROW } : r)),
      summary: p.output?.summary ?? null,
      source: 'astra' as const,
      batch: null,
    })),
    mintBatch: assign(({ context }) => ({
      batch: context.batch ?? { opId: crypto.randomUUID(), rows: context.rows },
      message: null,
    })),
    markStale: assign(({ context }, p: Out) => ({
      rows: markStale(context.rows, p.output),
      batch: null,
    })),
    sayRefused: assign((_, p: Out) => ({
      message: p.output.kind === 'refused' ? p.output.message : null,
    })),
    dropBatch: assign({ batch: null }),
    /** The host never got it: the batch's rows go back to the confirm (same batch opId). */
    resendBatch: assign(({ context }) => ({ rows: sent(context), message: null })),
    /** Definite failures stay with their errors; the next try is a fresh confirm. */
    keepFailed: assign(({ context }, p: Out) => ({
      rows: openRows(sent(context), p.output),
      batch: null,
    })),
    /** Some outcome is unknown: the open rows show it; the batch stays exactly as sent. */
    keepOpen: assign(({ context }, p: Out) => ({ rows: openRows(sent(context), p.output) })),
    sayLost: assign((_, p: { error: unknown }) => ({
      message: `${errorText(p.error)} ${LOST_ANSWER}`,
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
            guard: { type: 'staleProposal', params: ({ event }) => ({ output: event.output }) },
            target: 'stale',
            actions: { type: 'takeProposal', params: ({ event }) => ({ output: event.output }) },
          },
          {
            target: 'reviewingProposal',
            actions: { type: 'takeProposal', params: ({ event }) => ({ output: event.output }) },
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
        input: ({ context }) => context.batch!,
        onDone: [
          {
            guard: { type: 'isStale', params: out },
            target: 'stale',
            actions: { type: 'markStale', params: out },
          },
          {
            guard: { type: 'isRefused', params: out },
            target: 'back',
            actions: [{ type: 'sayRefused', params: out }, 'dropBatch'],
          },
          {
            guard: { type: 'isUnsent', params: out },
            target: 'confirming',
            actions: 'resendBatch',
          },
          { guard: { type: 'allApplied', params: out }, target: 'applied', actions: 'clear' },
          {
            guard: { type: 'anyUnknown', params: out },
            target: 'unknown',
            actions: { type: 'keepOpen', params: out },
          },
          { target: 'partiallyFailed', actions: { type: 'keepFailed', params: out } },
        ],
        onError: {
          target: 'unknown',
          actions: { type: 'sayLost', params: ({ event }) => ({ error: event.error }) },
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
    /** Some row may or may not be written: only Check (or Discard) until the host says. */
    unknown: {
      on: {
        'plan.check': 'checking',
        'plan.discard': { target: 'viewing', actions: 'clear' },
      },
    },
    checking: {
      invoke: {
        src: 'check',
        input: ({ context }) => context.batch!,
        onDone: [
          {
            guard: { type: 'isRefused', params: out },
            target: 'unknown',
            actions: { type: 'sayRefused', params: out },
          },
          {
            guard: { type: 'isUnsent', params: out },
            target: 'confirming',
            actions: 'resendBatch',
          },
          { guard: { type: 'allApplied', params: out }, target: 'applied', actions: 'clear' },
          {
            guard: { type: 'anyUnknown', params: out },
            target: 'unknown',
            actions: [{ type: 'keepOpen', params: out }, assign({ message: STILL_UNKNOWN })],
          },
          { target: 'partiallyFailed', actions: { type: 'keepFailed', params: out } },
        ],
        onError: {
          target: 'unknown',
          actions: { type: 'sayLost', params: ({ event }) => ({ error: event.error }) },
        },
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

/** The rows the last write or check was about: the batch as sent, else the draft. */
function sent(context: PlanContext): DraftRow[] {
  return context.batch?.rows ?? context.rows
}

function markStale(rows: readonly DraftRow[], output: ApplyOutput): DraftRow[] {
  const keys = new Set(output.kind === 'stale' ? output.keys : [])
  return rows.map((r) => (keys.has(r.key) ? { ...r, stale: true, error: STALE_ROW } : r))
}

/** The rows not written (failed or unknown), with their errors (done rows leave the draft). */
function openRows(rows: readonly DraftRow[], output: ApplyOutput): DraftRow[] {
  const results = new Map(output.kind === 'done' ? output.results.map((r) => [r.key, r]) : [])
  return rows
    .filter((r) => results.get(r.key)?.state !== 'done')
    .map((r) => ({ ...r, error: results.get(r.key)?.error ?? 'Not written' }))
}
