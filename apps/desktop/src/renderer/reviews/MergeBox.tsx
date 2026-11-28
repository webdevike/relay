// The PR sidebar's merge box (PLAN §2.6): one Merge now button with the repository's allowed
// methods, and a confirm naming the repo and PR, head short SHA, base and method. The write is the
// host gate's (prMergeMachine over `reviews.prPrepare`/`reviews.prCommit`): an immediate merge of
// that head, never `--admin`, never auto-merge or a merge queue. When GitHub won't merge it right
// now the box says why. Hidden when the host sent no actions facts.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, SegmentedControl } from '@mantine/core'
import { useActorRef, useSelector } from '@xstate/react'
import { fromPromise, type ActorRefFrom } from 'xstate'
import { IconGitMerge } from '@tabler/icons-react'
import type { ReviewPr } from '@evaos/contract'
import type { PrMutation } from '@relay/protocol'
import { EvaModal } from '../overlay'
import { mergeOfferOf, type MergeOffer } from '../tickets/pr-status'
import {
  prMergeMachine,
  type CommitResult,
  type MergeMethod,
  type MergePlan,
  type MergePr,
  type PrMergeContext,
  type PrepareResult,
} from './pr-merge.machine'
import { prCommit, prPrepare, type PrStep } from './pr-write'

function prepareResult(s: PrStep): PrepareResult {
  if (s.kind === 'approval') return { kind: 'approved', approvalId: s.id }
  if (s.kind === 'refused') return s
  return { kind: 'failed', message: s.kind === 'done' ? 'Nothing to approve' : s.message }
}

function commitResult(s: PrStep): CommitResult {
  if (s.kind === 'done') return { kind: s.outcome.result?.merge ?? 'done' }
  if (s.kind === 'approval') return { kind: 'failed', message: 'The host asked for an approval' }
  return s
}

const liveMachine = prMergeMachine.provide({
  actors: {
    prepare: fromPromise(async ({ input }) =>
      prepareResult(await prPrepare(input.mutation as PrMutation, input.login)),
    ),
    commit: fromPromise(async ({ input }) =>
      commitResult(await prCommit({ ...input, mutation: input.mutation as PrMutation })),
    ),
  },
})

const METHOD_WORD: Record<MergeMethod, string> = {
  merge: 'Merge commit',
  squash: 'Squash',
  rebase: 'Rebase',
}

type Offered = Extract<MergeOffer, { kind: 'offer' }>

/** The method the box starts on: squash when the repo allows it, else its first. */
const firstMethod = (o: Offered): MergeMethod =>
  o.methods.includes('squash') ? 'squash' : o.methods[0]!

function ConfirmMerge({
  pr,
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  pr: MergePr
  plan: { method: MergeMethod; headSha: string }
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const rows: Array<[string, string]> = [
    ['Pull request', `${pr.repo}#${pr.number}`],
    ['Head', plan.headSha.slice(0, 7)],
    ['Base', pr.base],
    ['Method', METHOD_WORD[plan.method]],
  ]
  return (
    <EvaModal opened onClose={onCancel} title="Merge now?" size={440}>
      <dl className="eva-rv-merge-facts" data-testid="pr-merge-facts">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="eva-rv-dim">{k}</dt>
            <dd className={k === 'Head' ? 'eva-rv-mono' : undefined} data-testid={`pr-merge-${k}`}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="eva-rv-dim eva-rv-small">
        Merges only this head as you on GitHub; if new commits land first, nothing is merged.
      </div>
      <div className="eva-rv-modal-actions">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button loading={busy} onClick={onConfirm} data-testid="pr-merge-confirm">
          Merge now
        </Button>
      </div>
    </EvaModal>
  )
}

function Notice({
  text,
  tone,
  children,
}: {
  text: string
  tone: 'ok' | 'bad' | 'dim'
  children?: ReactNode
}) {
  return (
    <div className="eva-rv-merge-note" data-tone={tone} role="status" data-testid="pr-merge-note">
      <span>{text}</span>
      {children ? <span className="eva-rv-merge-acts">{children}</span> : null}
    </div>
  )
}

const selectState = (s: { value: unknown }) => s.value as string
const selectContext = (s: { context: PrMergeContext }) => s.context

/** The plan the button starts: Merge now with the picked (still allowed) method. */
function planOf(offer: MergeOffer, method: MergeMethod | null): Plan | null {
  if (offer.kind !== 'offer') return null
  return { method: method && offer.methods.includes(method) ? method : firstMethod(offer) }
}

/** States a merge lands in; arriving from `merging` reads the PR again. */
const LANDED: Record<string, true> = { merged: true, idle: true }
/** States the confirm stays open in (busy while the gate approves and the merge is written). */
const CONFIRM_OPEN: Record<string, true> = { confirming: true, preparing: true, merging: true }

type MergeActor = ActorRefFrom<typeof prMergeMachine>
type Plan = Omit<MergePlan, 'headSha'>

/** The machine for this PR, told every read's head and whether Merge now is offered; a landed write reads again. */
function useMerge(pr: ReviewPr, offer: MergeOffer, onChanged: () => void) {
  const actor = useActorRef(liveMachine)
  const state = useSelector(actor, selectState)
  const ctx = useSelector(actor, selectContext)
  const facts: MergePr = {
    repo: pr.repo,
    number: pr.number,
    base: pr.base,
    headSha: pr.headSha ?? '',
    login: pr.actions?.viewerLogin ?? '',
  }
  const offered = offer.kind === 'offer'
  useEffect(() => {
    actor.send({ type: 'merge.facts', pr: facts, offered })
  }, [actor, pr.headSha, pr.updatedAt, offered])

  const was = useRef(state)
  useEffect(() => {
    const wrote = was.current === 'merging'
    was.current = state
    if (wrote && LANDED[state]) onChanged()
  }, [state])
  return { actor, state, ctx, facts }
}

/** The box's buttons as machine events (each Isaac action mints its own opId). */
function actionsOf(actor: MergeActor, plan: Plan | null, facts: MergePr) {
  return {
    onStart: () => plan && actor.send({ type: 'merge.start', pr: facts, plan }),
    onReconfirm: () => plan && actor.send({ type: 'merge.reconfirm', plan }),
    onCancel: () => actor.send({ type: 'merge.cancel' }),
    onRetry: () => actor.send({ type: 'merge.retry' }),
    onDismiss: () => actor.send({ type: 'merge.dismiss' }),
  }
}

export function MergeBox({ pr, onChanged }: { pr: ReviewPr; onChanged: () => void }) {
  const offer = mergeOfferOf(pr)
  const [method, setMethod] = useState<MergeMethod | null>(null)
  const plan = planOf(offer, method)
  const { actor, state, ctx, facts } = useMerge(pr, offer, onChanged)
  if (offer.kind === 'hidden') return null
  return (
    <div className="eva-rv-merge" data-testid="pr-merge" data-state={state}>
      <MergeBody
        state={state}
        message={ctx.message}
        offer={offer}
        picked={plan?.method ?? null}
        onPick={setMethod}
        {...actionsOf(actor, plan, facts)}
        canReconfirm={plan !== null}
      />
      <OpenConfirm actor={actor} state={state} ctx={ctx} />
    </div>
  )
}

/** The confirm while Isaac decides, and busy while the gate approves and the merge is written. */
function OpenConfirm({
  actor,
  state,
  ctx,
}: {
  actor: MergeActor
  state: string
  ctx: PrMergeContext
}) {
  if (!CONFIRM_OPEN[state] || !ctx.pr || !ctx.plan) return null
  return (
    <ConfirmMerge
      pr={ctx.pr}
      plan={ctx.plan}
      busy={state !== 'confirming'}
      onConfirm={() => actor.send({ type: 'merge.confirm', opId: crypto.randomUUID() })}
      onCancel={() => state === 'confirming' && actor.send({ type: 'merge.cancel' })}
    />
  )
}

interface BodyProps {
  state: string
  message: string | null
  offer: MergeOffer
  picked: MergeMethod | null
  onPick: (m: MergeMethod) => void
  onStart: () => void
  onReconfirm: () => void
  onCancel: () => void
  onRetry: () => void
  onDismiss: () => void
  canReconfirm: boolean
}

/** What the box says in each state of the machine (the confirm is the modal above). */
const BODIES: Record<string, (p: BodyProps) => ReactNode> = {
  merged: () => <Notice text="Merged." tone="ok" />,
  stale: (p) => (
    <Notice text={p.message ?? ''} tone="bad">
      {p.canReconfirm ? (
        <Button size="compact-xs" onClick={p.onReconfirm} data-testid="pr-merge-reconfirm">
          Confirm again
        </Button>
      ) : null}
      <Button size="compact-xs" variant="subtle" color="gray" onClick={p.onCancel}>
        Cancel
      </Button>
    </Notice>
  ),
  refused: (p) => (
    <Notice text={p.message ?? 'Refused; nothing was merged.'} tone="bad">
      <Button size="compact-xs" variant="subtle" color="gray" onClick={p.onDismiss}>
        Dismiss
      </Button>
    </Notice>
  ),
  failed: (p) => (
    <Notice text={p.message ?? 'It didn’t merge.'} tone="bad">
      <Button size="compact-xs" variant="subtle" onClick={p.onRetry} data-testid="pr-merge-retry">
        Retry
      </Button>
      <Button size="compact-xs" variant="subtle" color="gray" onClick={p.onCancel}>
        Cancel
      </Button>
    </Notice>
  ),
}

function MergeBody(p: BodyProps) {
  const body = BODIES[p.state]
  if (body) return body(p)
  if (p.offer.kind === 'none')
    return (
      <div className="eva-rv-dim eva-rv-small" data-testid="pr-merge-none">
        {p.offer.reason}
      </div>
    )
  if (p.offer.kind !== 'offer') return null
  return (
    <>
      {p.offer.methods.length > 1 ? (
        <SegmentedControl
          size="xs"
          fullWidth
          value={p.picked ?? undefined}
          onChange={(v) => p.onPick(v as MergeMethod)}
          data={p.offer.methods.map((m) => ({ value: m, label: METHOD_WORD[m] }))}
          data-testid="pr-merge-method"
        />
      ) : null}
      <Button
        size="xs"
        fullWidth
        leftSection={<IconGitMerge size={14} />}
        loading={p.state === 'preparing' || p.state === 'merging'}
        onClick={p.onStart}
        data-testid="pr-merge-start"
      >
        Merge now
      </Button>
    </>
  )
}
