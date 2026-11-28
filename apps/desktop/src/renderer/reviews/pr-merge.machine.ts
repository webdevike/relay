import { assign, fromPromise, setup } from 'xstate'

/**
 * Merging a PR from its page (docs/state-machines/pr-merge.md): Isaac picks the merge box's one
 * outcome ("Merge now", "Add to merge queue", "Turn on auto-merge"), confirms it with the repo, head
 * short SHA, base and method in view, and the host's write gate approves it (`prepare`) and writes
 * it bound to that head (`commit`, `--match-head-commit`, never `--admin`). A newer read whose head
 * or outcome differs, before the write goes out or as the host's `conflict` refusal, makes the
 * confirm `stale`: Isaac confirms again. The opId is minted at the confirm and reused by retry, so
 * a lost answer never merges twice. An armed auto-merge can be turned off (`disarming`). The
 * runtime (MergeBox.tsx) provides `prepare` and `commit`.
 */

export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** The PR as the latest read has it. */
export interface MergePr {
  repo: string
  number: number
  base: string
  /** Full head SHA. */
  headSha: string
}

/** What Isaac confirms: one outcome for one head. */
export interface MergePlan {
  method: MergeMethod
  intent: 'merge' | 'auto'
  outcome: string
  headSha: string
}

/** protocol PrMutation `merge` / `autoMerge` (types, so they fit the IPC's loose mutation shape). */
export type MergeMutation =
  | {
      kind: 'merge'
      repo: string
      number: number
      method: MergeMethod
      intent: 'merge' | 'auto'
      expectHead: string
    }
  | { kind: 'autoMerge'; repo: string; number: number; on: false; expectHead: string }

export type PrepareResult =
  | { kind: 'approved'; approvalId: string }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'failed'; message: string }

export type CommitResult =
  /** Read back after the write (protocol outcome `result.merge`); `done` for a write without one (disarm). */
  | { kind: 'merged' | 'queued' | 'autoMergeArmed' | 'done' }
  | { kind: 'refused'; code: string; message: string }
  /** `unknown`: the answer was lost; retry asks again with the same opId. */
  | { kind: 'failed' | 'unknown'; message: string }

export interface CommitInput {
  opId: string
  approvalId: string | null
  mutation: MergeMutation
}

export interface Armed {
  method: MergeMethod
  by: string | null
}

export interface PrMergeContext {
  pr: MergePr | null
  plan: MergePlan | null
  /** Minted at the confirm (or the disarm); every retry of that write reuses it. */
  opId: string
  approvalId: string | null
  armed: Armed | null
  message: string | null
}

export type PrMergeEvent =
  | { type: 'merge.start'; pr: MergePr; plan: Omit<MergePlan, 'headSha'> }
  | { type: 'merge.confirm'; opId: string }
  | { type: 'merge.cancel' }
  /** A newer read: its head, the outcome the merge box would offer now (null: none), auto-merge. */
  | { type: 'merge.facts'; pr: MergePr; outcome: string | null; armed: Armed | null }
  | { type: 'merge.reconfirm'; plan: Omit<MergePlan, 'headSha'> }
  | { type: 'merge.retry' }
  | { type: 'merge.disarm'; opId: string }
  | { type: 'merge.dismiss' }

export const CHECKING = 'Checking whether it merged'
export const CHANGED = 'The pull request changed since you confirmed; nothing was merged'

const EMPTY: PrMergeContext = {
  pr: null,
  plan: null,
  opId: '',
  approvalId: null,
  armed: null,
  message: null,
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong'

type Done<T> = { event: { output: T } }
const approved = ({ event }: Done<PrepareResult>) => event.output.kind === 'approved'
const conflicted = ({ event }: Done<PrepareResult | CommitResult>) =>
  event.output.kind === 'refused' && event.output.code === 'conflict'
const refusedOut = ({ event }: Done<PrepareResult | CommitResult>) =>
  event.output.kind === 'refused'
const mergedOut = ({ event }: Done<CommitResult>) => event.output.kind === 'merged'
const queuedOut = ({ event }: Done<CommitResult>) => event.output.kind === 'queued'
const armedOut = ({ event }: Done<CommitResult>) => event.output.kind === 'autoMergeArmed'
const disarmedOut = ({ event }: Done<CommitResult>) =>
  event.output.kind === 'done' || event.output.kind === 'merged'

/** The message a refusal or failure carries. */
const messageOf = ({ event }: Done<PrepareResult | CommitResult>): string =>
  'message' in event.output ? event.output.message : 'Nothing was written'

function mergeMutation(context: PrMergeContext): MergeMutation {
  const { pr, plan } = context
  return {
    kind: 'merge',
    repo: pr!.repo,
    number: pr!.number,
    method: plan!.method,
    intent: plan!.intent,
    expectHead: plan!.headSha,
  }
}

function disarmMutation(context: PrMergeContext): MergeMutation {
  const { pr } = context
  return {
    kind: 'autoMerge',
    repo: pr!.repo,
    number: pr!.number,
    on: false,
    expectHead: pr!.headSha,
  }
}

export const prMergeMachine = setup({
  types: {
    context: {} as PrMergeContext,
    events: {} as PrMergeEvent,
  },
  actors: {
    prepare: fromPromise<PrepareResult, { mutation: MergeMutation }>(async () => {
      throw new Error('prepare not provided')
    }),
    commit: fromPromise<CommitResult, CommitInput>(async () => {
      throw new Error('commit not provided')
    }),
  },
  guards: {
    /** The newer read has another head or would offer another outcome than the one confirmed. */
    planChanged: ({ context, event }) =>
      event.type === 'merge.facts' &&
      context.plan !== null &&
      (event.pr.headSha !== context.plan.headSha || event.outcome !== context.plan.outcome),
    isArmed: ({ event }) => event.type === 'merge.facts' && event.armed !== null,
    notArmed: ({ event }) => event.type === 'merge.facts' && event.armed === null,
    hasApproval: ({ context }) => context.approvalId !== null,
  },
  actions: {
    takeStart: assign(({ event }) =>
      event.type === 'merge.start'
        ? { ...EMPTY, pr: event.pr, plan: { ...event.plan, headSha: event.pr.headSha } }
        : {},
    ),
    takeReconfirm: assign(({ context, event }) =>
      event.type === 'merge.reconfirm' && context.pr
        ? {
            plan: { ...event.plan, headSha: context.pr.headSha },
            approvalId: null,
            message: null,
          }
        : {},
    ),
    takeFacts: assign(({ event }) => (event.type === 'merge.facts' ? { pr: event.pr } : {})),
    takeArmed: assign(({ event }) =>
      event.type === 'merge.facts' ? { pr: event.pr, armed: event.armed } : {},
    ),
    goneStale: assign({ approvalId: null, message: CHANGED }),
    takeOpId: assign(({ event }) =>
      event.type === 'merge.confirm' || event.type === 'merge.disarm'
        ? { opId: event.opId, approvalId: null, message: null }
        : {},
    ),
    clear: assign(({ context }) => ({ ...EMPTY, pr: context.pr })),
  },
}).createMachine({
  id: 'prMerge',
  context: EMPTY,
  initial: 'idle',
  states: {
    idle: {
      entry: 'clear',
      on: {
        'merge.start': { target: 'confirming', actions: 'takeStart' },
        'merge.facts': [
          { guard: 'isArmed', target: 'autoMergeArmed', actions: 'takeArmed' },
          { actions: 'takeFacts' },
        ],
      },
    },
    // The confirm shows repo/PR, head short SHA, base, method and the exact outcome.
    confirming: {
      on: {
        'merge.confirm': { target: 'preparing', actions: 'takeOpId' },
        'merge.cancel': 'idle',
        'merge.facts': [
          { guard: 'planChanged', target: 'stale', actions: ['takeFacts', 'goneStale'] },
          { actions: 'takeFacts' },
        ],
      },
    },
    // Head or outcome moved since Isaac looked: nothing goes out until he confirms the new one.
    stale: {
      on: {
        'merge.reconfirm': { target: 'confirming', actions: 'takeReconfirm' },
        'merge.cancel': 'idle',
        'merge.facts': { actions: 'takeFacts' },
      },
    },
    preparing: {
      on: {
        'merge.facts': [
          { guard: 'planChanged', target: 'stale', actions: ['takeFacts', 'goneStale'] },
          { actions: 'takeFacts' },
        ],
      },
      invoke: {
        src: 'prepare',
        input: ({ context }) => ({ mutation: mergeMutation(context) }),
        onDone: [
          {
            guard: approved,
            target: 'merging',
            actions: assign({
              approvalId: ({ event }) =>
                event.output.kind === 'approved' ? event.output.approvalId : null,
            }),
          },
          { guard: conflicted, target: 'stale', actions: 'goneStale' },
          { guard: refusedOut, target: 'refused', actions: assign({ message: messageOf }) },
          { target: 'failed', actions: assign({ message: messageOf }) },
        ],
        onError: {
          target: 'failed',
          actions: assign({ message: ({ event }) => errorText(event.error) }),
        },
      },
    },
    merging: {
      invoke: {
        src: 'commit',
        input: ({ context }) => ({
          opId: context.opId,
          approvalId: context.approvalId,
          mutation: mergeMutation(context),
        }),
        onDone: [
          { guard: mergedOut, target: 'merged' },
          { guard: queuedOut, target: 'queued' },
          {
            guard: armedOut,
            target: 'autoMergeArmed',
            actions: assign({
              armed: ({ context }) => ({ method: context.plan!.method, by: null }),
            }),
          },
          { guard: conflicted, target: 'stale', actions: 'goneStale' },
          { guard: refusedOut, target: 'refused', actions: assign({ message: messageOf }) },
          { target: 'failed', actions: assign({ message: messageOf }) },
        ],
        // No answer: it may have merged. Retry asks the host about the same opId.
        onError: { target: 'failed', actions: assign({ message: CHECKING }) },
      },
    },
    merged: { on: { 'merge.dismiss': 'idle' } },
    queued: { on: { 'merge.dismiss': 'idle' } },
    // Approved for this head only: the host turns it off when new commits land.
    autoMergeArmed: {
      on: {
        'merge.disarm': { target: 'disarming', actions: 'takeOpId' },
        'merge.facts': [
          { guard: 'notArmed', target: 'idle', actions: 'takeFacts' },
          { actions: 'takeArmed' },
        ],
        'merge.dismiss': { actions: assign({ message: null }) },
      },
    },
    disarming: {
      invoke: {
        src: 'commit',
        input: ({ context }) => ({
          opId: context.opId,
          approvalId: null,
          mutation: disarmMutation(context),
        }),
        onDone: [
          { guard: disarmedOut, target: 'idle' },
          { target: 'autoMergeArmed', actions: assign({ message: messageOf }) },
        ],
        onError: {
          target: 'autoMergeArmed',
          actions: assign({ message: ({ event }) => errorText(event.error) }),
        },
      },
    },
    refused: {
      on: {
        'merge.dismiss': 'idle',
        'merge.cancel': 'idle',
        'merge.start': { target: 'confirming', actions: 'takeStart' },
      },
    },
    failed: {
      on: {
        'merge.retry': [{ guard: 'hasApproval', target: 'merging' }, { target: 'preparing' }],
        'merge.cancel': 'idle',
      },
    },
  },
})
