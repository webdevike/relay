import { assign, fromPromise, setup } from 'xstate'

/**
 * Merging a PR from its page (docs/state-machines/pr-merge.md): Isaac picks Merge now, confirms it
 * with the repo, head short SHA, base and method in view, and the host's write gate approves it
 * (`prepare`) and merges exactly that head at once (`commit`, `--match-head-commit`, never
 * `--admin`, never auto-merge or a merge queue). A newer read with another head, or one GitHub
 * would no longer merge right now, before the write goes out or as the host's `conflict` refusal,
 * makes the confirm `stale`: Isaac confirms again. The opId is minted at the confirm and reused by
 * retry, so a lost answer never merges twice. The runtime (MergeBox.tsx) provides `prepare` and
 * `commit`.
 */

export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** The PR as the latest read has it. */
export interface MergePr {
  repo: string
  number: number
  base: string
  /** Full head SHA. */
  headSha: string
  /** The gh login the read showed (`actions.viewerLogin`); the host refuses another. */
  login: string
}

/** What Isaac confirms: one method for one head (and the PR's base). */
export interface MergePlan {
  method: MergeMethod
  headSha: string
}

/** protocol PrMutation `merge` (a type, so it fits the IPC's loose mutation shape). */
export interface MergeMutation {
  kind: 'merge'
  repo: string
  number: number
  method: MergeMethod
  expectHead: string
  expectBase: string
}

export type PrepareResult =
  | { kind: 'approved'; approvalId: string }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'failed'; message: string }

export type CommitResult =
  /** Read back after the write (protocol outcome `result.merge`); `done` when the host said no more. */
  | { kind: 'merged' | 'done' }
  | { kind: 'refused'; code: string; message: string }
  /** `unknown`: the answer was lost; retry asks again with the same opId. */
  | { kind: 'failed' | 'unknown'; message: string }

export interface CommitInput {
  opId: string
  approvalId: string | null
  mutation: MergeMutation
  login: string
}

export interface PrMergeContext {
  pr: MergePr | null
  plan: MergePlan | null
  /** Minted at the confirm; every retry of that write reuses it. */
  opId: string
  approvalId: string | null
  message: string | null
}

export type PrMergeEvent =
  | { type: 'merge.start'; pr: MergePr; plan: Omit<MergePlan, 'headSha'> }
  | { type: 'merge.confirm'; opId: string }
  | { type: 'merge.cancel' }
  /** A newer read: its head, and whether the merge box would still offer Merge now. */
  | { type: 'merge.facts'; pr: MergePr; offered: boolean }
  | { type: 'merge.reconfirm'; plan: Omit<MergePlan, 'headSha'> }
  | { type: 'merge.retry' }
  | { type: 'merge.dismiss' }

export const CHECKING = 'Checking whether it merged'
export const CHANGED = 'The pull request changed since you confirmed; nothing was merged'

const EMPTY: PrMergeContext = { pr: null, plan: null, opId: '', approvalId: null, message: null }

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : 'Something went wrong'

type Done<T> = { event: { output: T } }
const approved = ({ event }: Done<PrepareResult>) => event.output.kind === 'approved'
const conflicted = ({ event }: Done<PrepareResult | CommitResult>) =>
  event.output.kind === 'refused' && event.output.code === 'conflict'
const refusedOut = ({ event }: Done<PrepareResult | CommitResult>) =>
  event.output.kind === 'refused'
const mergedOut = ({ event }: Done<CommitResult>) => event.output.kind === 'merged'

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
    expectHead: plan!.headSha,
    expectBase: pr!.base,
  }
}

export const prMergeMachine = setup({
  types: {
    context: {} as PrMergeContext,
    events: {} as PrMergeEvent,
  },
  actors: {
    prepare: fromPromise<PrepareResult, { mutation: MergeMutation; login: string }>(async () => {
      throw new Error('prepare not provided')
    }),
    commit: fromPromise<CommitResult, CommitInput>(async () => {
      throw new Error('commit not provided')
    }),
  },
  guards: {
    /** The newer read has another head than the one confirmed, or GitHub won't merge it right now. */
    planChanged: ({ context, event }) =>
      event.type === 'merge.facts' &&
      context.plan !== null &&
      (event.pr.headSha !== context.plan.headSha || !event.offered),
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
    goneStale: assign({ approvalId: null, message: CHANGED }),
    takeOpId: assign(({ event }) =>
      event.type === 'merge.confirm' ? { opId: event.opId, approvalId: null, message: null } : {},
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
        'merge.facts': { actions: 'takeFacts' },
      },
    },
    // The confirm shows repo/PR, head short SHA, base and method.
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
    // Head moved, or GitHub won't merge it now: nothing goes out until he confirms the new one.
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
        input: ({ context }) => ({ mutation: mergeMutation(context), login: context.pr!.login }),
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
          login: context.pr!.login,
        }),
        onDone: [
          { guard: mergedOut, target: 'merged' },
          { guard: conflicted, target: 'stale', actions: 'goneStale' },
          { guard: refusedOut, target: 'refused', actions: assign({ message: messageOf }) },
          { target: 'failed', actions: assign({ message: messageOf }) },
        ],
        // No answer: it may have merged. Retry asks the host about the same opId.
        onError: { target: 'failed', actions: assign({ message: CHECKING }) },
      },
    },
    merged: { on: { 'merge.dismiss': 'idle' } },
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
