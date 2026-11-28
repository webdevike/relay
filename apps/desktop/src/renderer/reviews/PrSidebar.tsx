// The PR page's sidebar (PLAN T5.2): status and why it can't merge in plain words, the merge box,
// reviewers with Request review (picker, then the gate's confirm), checks deduped by Actions run
// with Re-run failed on eligible rows, linked tickets, labels and details. Folded, `PrStrip` says
// the same in one line under the header; both read `prStatusOf`, as the ticket page's strip does.
// Writes go only through the host gate and only show when the host sent actions facts.
import { useState } from 'react'
import { Button, Checkbox, TextInput, UnstyledButton } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconExternalLink,
  IconRefresh,
  IconUserPlus,
} from '@tabler/icons-react'
import type { ReviewPr } from '@evaos/contract'
import { openLink } from '../navigation/open-link'
import { openPlace } from '../navigation/navigate'
import { EvaPopover } from '../overlay'
import { ConfirmPost, MutationNotice } from '../tickets/Composer'
import { prSignalsOfReview, prStatusOf, type PrStatus } from '../tickets/pr-status'
import { ticketPlace } from '../tickets/ticket-place'
import { MergeBox } from './MergeBox'
import { ApprovalNote } from '../tickets/ApprovalNote'
import { prLoginOf, prWritesOn, usePrWrite } from './pr-write'
import { Avatar, RailSection } from './review-ui'

const REVIEW_STATE: Record<string, { label: string; tone: string }> = {
  PENDING: { label: 'Pending', tone: 'amber' },
  APPROVED: { label: 'Approved', tone: 'green' },
  CHANGES_REQUESTED: { label: 'Changes', tone: 'red' },
  COMMENTED: { label: 'Commented', tone: 'gray' },
  DISMISSED: { label: 'Dismissed', tone: 'gray' },
}

export function reviewStateOf(state: string): { label: string; tone: string } {
  return REVIEW_STATE[state] ?? { label: state.toLowerCase(), tone: 'gray' }
}

export function prStatusOfPr(pr: ReviewPr): PrStatus {
  return prStatusOf(prSignalsOfReview(pr))
}

/** One line under the header while the sidebar is folded: state, why it can't merge, checks, conflicts. */
export function PrStrip({ pr }: { pr: ReviewPr }) {
  const s = prStatusOfPr(pr)
  return (
    <div className="eva-rv-strip" data-testid="pr-strip">
      <span className="eva-rv-pill" data-tone={s.state === 'Merged' ? 'violet' : 'gray'}>
        {s.state}
      </span>
      <span className="eva-rv-strip-line" data-tone={s.tone} data-testid="pr-strip-line">
        {s.line}
      </span>
      <span className="eva-rv-dim">{s.checks}</span>
      {s.conflicts ? <span className="eva-rv-dim">{s.conflicts}</span> : null}
    </div>
  )
}

function StatusSection({ pr }: { pr: ReviewPr }) {
  const s = prStatusOfPr(pr)
  const dirty = pr.actions?.mergeStateStatus === 'DIRTY'
  return (
    <RailSection title="Status">
      <div className="eva-rv-strip-line" data-tone={s.tone} data-testid="pr-status-line">
        {s.line}
      </div>
      {s.note ? (
        <div className="eva-rv-dim" data-testid="pr-status-note">
          {s.note}
        </div>
      ) : null}
      {dirty ? (
        <UnstyledButton
          className="eva-rv-conflicts"
          onClick={() => openLink(`${pr.url}/conflicts`, { reviews: false })}
          data-testid="pr-conflicts"
        >
          <IconAlertTriangle size={14} />
          Conflicts with {pr.base}
          <IconExternalLink size={12} className="eva-rv-dim" />
        </UnstyledButton>
      ) : s.conflicts ? (
        <div className="eva-rv-dim">{s.conflicts}</div>
      ) : null}
    </RailSection>
  )
}

/** Who can be asked: the PR's people who aren't its author or already reviewers. */
function candidatesOf(pr: ReviewPr): string[] {
  const taken = new Set([pr.author.login, ...pr.reviewers.map((r) => r.login)])
  return [...new Set([...pr.assignees, ...pr.participants])].filter((l) => !taken.has(l))
}

/** Logins typed in the box: separated by commas or spaces, without a leading @. */
const typedLogins = (text: string): string[] =>
  text
    .split(/[\s,]+/)
    .map((l) => l.replace(/^@/, ''))
    .filter(Boolean)

function RequestReview({ pr, onChanged }: { pr: ReviewPr; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [typed, setTyped] = useState('')
  const write = usePrWrite(prLoginOf(pr), () => {
    notifications.show({ message: 'Review requested.', color: 'green' })
    setPicked([])
    setTyped('')
    onChanged()
  })
  const logins = [...new Set([...picked, ...typedLogins(typed)])]
  const request = (): void => {
    setOpen(false)
    write.run({ kind: 'requestReview', repo: pr.repo, number: pr.number, logins })
  }
  const v = write.view
  return (
    <>
      <EvaPopover opened={open} onChange={setOpen} position="bottom-start" width={240}>
        <EvaPopover.Target>
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconUserPlus size={13} />}
            loading={v.kind === 'preparing'}
            onClick={() => setOpen((o) => !o)}
            data-testid="pr-request-review"
          >
            Request review
          </Button>
        </EvaPopover.Target>
        <EvaPopover.Dropdown>
          <div className="eva-rv-picker" data-testid="pr-reviewer-picker">
            {candidatesOf(pr).map((l) => (
              <Checkbox
                key={l}
                size="xs"
                label={l}
                checked={picked.includes(l)}
                onChange={(e) =>
                  setPicked(
                    e.currentTarget.checked ? [...picked, l] : picked.filter((x) => x !== l),
                  )
                }
              />
            ))}
            <TextInput
              size="xs"
              placeholder="login or org/team"
              value={typed}
              onChange={(e) => setTyped(e.currentTarget.value)}
              data-testid="pr-reviewer-input"
            />
            <Button
              size="xs"
              disabled={logins.length === 0}
              onClick={request}
              data-testid="pr-reviewer-send"
            >
              Request
            </Button>
          </div>
        </EvaPopover.Dropdown>
      </EvaPopover>
      <ConfirmPost
        opened={v.kind === 'confirming' || v.kind === 'committing'}
        title="Request review on GitHub?"
        text={logins.join(', ')}
        note={
          v.kind === 'confirming' ? (
            <ApprovalNote approval={v.approval} />
          ) : (
            `Asks them as you on ${pr.repo}#${pr.number}.`
          )
        }
        confirmLabel="Request review"
        busy={v.kind === 'committing'}
        onConfirm={write.confirm}
        onCancel={write.cancel}
      />
      <MutationNotice view={v} onRetry={write.retry} onDismiss={write.cancel} />
    </>
  )
}

function ReviewersSection({ pr, onChanged }: { pr: ReviewPr; onChanged: () => void }) {
  return (
    <RailSection title="Reviewers">
      {pr.reviewers.length === 0 ? <div className="eva-rv-dim">No reviewers.</div> : null}
      {pr.reviewers.map((r) => {
        const s = reviewStateOf(r.state)
        return (
          <div key={r.login} className="eva-rv-rail-person" data-testid="pr-reviewer">
            <Avatar login={r.login} />
            <span className="eva-rv-ellipsis">{r.login}</span>
            <span className="eva-rv-spacer" />
            <span className="eva-rv-pill" data-tone={s.tone}>
              {s.label}
            </span>
          </div>
        )
      })}
      {prWritesOn(pr) && pr.state === 'OPEN' ? (
        <RequestReview pr={pr} onChanged={onChanged} />
      ) : null}
    </RailSection>
  )
}

export interface CheckRun {
  key: string
  name: string
  state: string
  url: string | null
  /** Checks in this run (its jobs). */
  jobs: number
  /** Set on a failed Actions run of the PR's head with a known attempt: Re-run failed may go. */
  rerun: { runId: number; attempt: number; headSha: string } | null
}

const STATE_ORDER = ['fail', 'pending', 'pass', 'skipped']
type ActionCheck = NonNullable<ReviewPr['actions']>['checks'][number]

/** A failed Actions run of the PR's head with a known attempt can re-run its failed jobs. */
function rerunOf(
  group: ActionCheck[],
  state: string,
  headSha: string | undefined,
): CheckRun['rerun'] {
  const runId = group[0]!.runId
  if (state !== 'fail' || runId === null || !headSha) return null
  const attempt = group.find((c) => c.attempt !== null && c.headSha === headSha)?.attempt
  return attempt ? { runId, attempt, headSha } : null
}

function runOf(group: ActionCheck[], headSha: string | undefined): CheckRun {
  const first = group[0]!
  const state = STATE_ORDER.find((s) => group.some((c) => c.state === s)) ?? first.state
  return {
    key: first.runId === null ? `check:${first.name}` : `run:${first.runId}`,
    name: first.workflow ?? first.name,
    state,
    url: group.find((c) => c.state === state && c.url)?.url ?? first.url,
    jobs: group.length,
    rerun: rerunOf(group, state, headSha),
  }
}

/** The PR's checks, one row per Actions run (its jobs together), else per check; failing first. */
export function checkRunsOf(pr: ReviewPr): CheckRun[] {
  const checks: ActionCheck[] =
    pr.actions?.checks ??
    pr.checks.map((c) => ({
      ...c,
      workflow: null,
      runId: null,
      runNumber: null,
      attempt: null,
      headSha: '',
    }))
  const groups = new Map<string, ActionCheck[]>()
  for (const c of checks) {
    const key = c.runId === null ? `check:${c.name}` : `run:${c.runId}`
    groups.set(key, [...(groups.get(key) ?? []), c])
  }
  return [...groups.values()]
    .map((g) => runOf(g, pr.headSha))
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state))
}

function CheckIcon({ state }: { state: string }) {
  if (state === 'pass') return <IconCircleCheck size={15} className="eva-rv-ok" />
  if (state === 'fail') return <IconCircleX size={15} className="eva-rv-bad" />
  return <IconCircleDashed size={15} className="eva-rv-dim" />
}

function ChecksSection({ pr, onChanged }: { pr: ReviewPr; onChanged: () => void }) {
  const runs = checkRunsOf(pr)
  const [running, setRunning] = useState<string | null>(null)
  const write = usePrWrite(prLoginOf(pr), () => {
    notifications.show({ message: `Re-running the failed jobs of ${running ?? 'the run'}.` })
    onChanged()
  })
  const busy = write.view.kind === 'committing'
  return (
    <RailSection title="Checks">
      {runs.length === 0 ? <div className="eva-rv-dim">No checks ran.</div> : null}
      <div className="eva-rv-checks" data-testid="review-checks">
        {runs.map((r) => (
          <div key={r.key} className="eva-rv-check" data-testid="pr-check" data-state={r.state}>
            <CheckIcon state={r.state} />
            <UnstyledButton
              className="eva-rv-ellipsis"
              disabled={!r.url}
              onClick={() => r.url && openLink(r.url)}
              title={r.jobs > 1 ? `${r.name} (${r.jobs} jobs)` : r.name}
            >
              {r.name}
            </UnstyledButton>
            <span className="eva-rv-spacer" />
            {r.rerun && prWritesOn(pr) ? (
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={<IconRefresh size={12} />}
                loading={busy && running === r.name}
                onClick={() => {
                  setRunning(r.name)
                  write.run({ kind: 'rerun', repo: pr.repo, number: pr.number, ...r.rerun! })
                }}
                data-testid="pr-check-rerun"
              >
                Re-run failed
              </Button>
            ) : (
              <span className="eva-rv-dim">{r.state}</span>
            )}
          </div>
        ))}
      </div>
      <MutationNotice view={write.view} onRetry={write.retry} onDismiss={write.cancel} />
    </RailSection>
  )
}

const KEY = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g

/** Linear keys the PR names in its title or branch (a body mention doesn't link it). */
export function linkedTicketsOf(pr: Pick<ReviewPr, 'title' | 'head'>): string[] {
  return [
    ...new Set(
      [...pr.title.matchAll(KEY), ...pr.head.toUpperCase().matchAll(KEY)].map((m) => m[0]),
    ),
  ]
}

function TicketsSection({ pr }: { pr: ReviewPr }) {
  const keys = linkedTicketsOf(pr)
  if (keys.length === 0) return null
  return (
    <RailSection title="Tickets">
      {keys.map((k) => (
        <UnstyledButton
          key={k}
          className="eva-rv-raillink"
          onClick={() => openPlace(ticketPlace(k))}
          data-testid="pr-linked-ticket"
        >
          <span className="eva-rv-mono">{k}</span>
        </UnstyledButton>
      ))}
    </RailSection>
  )
}

function Details({ pr }: { pr: ReviewPr }) {
  const rows: Array<[string, string]> = [
    ['Author', pr.author.login],
    ['Branch', `${pr.head} into ${pr.base}`],
    ['Assignees', pr.assignees.join(', ') || 'Nobody'],
    ['Milestone', pr.milestone ?? 'None'],
    ['Projects', pr.projects.join(', ') || 'None'],
  ]
  return (
    <RailSection title="Details">
      <dl className="eva-rv-details">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="eva-rv-dim">{k}</dt>
            <dd className="eva-rv-ellipsis" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="eva-rv-labels">
        {pr.participants.map((p) => (
          <Avatar key={p} login={p} />
        ))}
      </div>
    </RailSection>
  )
}

export function PrSidebar({ pr, onChanged }: { pr: ReviewPr; onChanged: () => void }) {
  return (
    <aside className="eva-rv-rail eva-rv-side" data-testid="review-rail">
      <StatusSection pr={pr} />
      {pr.actions ? (
        <section className="eva-rv-rail-sec">
          <MergeBox pr={pr} onChanged={onChanged} />
        </section>
      ) : null}
      <ReviewersSection pr={pr} onChanged={onChanged} />
      <ChecksSection pr={pr} onChanged={onChanged} />
      <TicketsSection pr={pr} />
      {pr.labels.length > 0 ? (
        <RailSection title="Labels">
          <div className="eva-rv-labels">
            {pr.labels.map((l) => (
              <span key={l.name} className="eva-rv-label" style={{ borderColor: `#${l.color}` }}>
                {l.name}
              </span>
            ))}
          </div>
        </RailSection>
      ) : null}
      <Details pr={pr} />
    </aside>
  )
}
