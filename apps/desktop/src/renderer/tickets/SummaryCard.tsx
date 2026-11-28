import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Button, Skeleton, Tooltip, UnstyledButton } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconAlertCircleFilled, IconAt, IconCheck, IconSparkles } from '@tabler/icons-react'
import type { AgentCard } from '@evaos/contract'
import type { HandledTarget } from '@relay/protocol'
import { invoke } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { useReplacePlace } from '../pages/place-host'
import { PersonAvatar } from '../agents-board/CardChips'
import { agoLabel } from '../agents-board/board-view'
import type { TicketData } from './ticket-data'
import { ticketPlace } from './ticket-place'
import {
  attentionLines,
  footerPrs,
  footerText,
  type NeedsLine,
  type WaitingLine,
} from './summary-model'
import './summary.css'

const TOAST_ID = 'ticket-handled'
const TOAST_MS = 6000

type SummaryView =
  { kind: 'loading' } | { kind: 'text'; text: string } | { kind: 'unavailable' } | { kind: 'off' }

/**
 * The host's 2-3 sentence summary for this ticket, re-asked when the ticket's snapshot moves (the
 * host caches by snapshot). Fallback mode asks nothing: facts only.
 */
function useSummary(data: TicketData): SummaryView {
  const [view, setView] = useState<SummaryView>({ kind: 'loading' })
  const { key, source, detail } = data
  const snapshot = detail ? `${detail.updatedAt}:${detail.comments.length}` : null
  useEffect(() => {
    if (source === 'fallback') return setView({ kind: 'off' })
    if (snapshot === null) return setView({ kind: data.unavailable ? 'off' : 'loading' })
    let live = true
    setView((v) => (v.kind === 'text' ? v : { kind: 'loading' }))
    void invoke('tickets.summary', { key }).then((r) => {
      if (!live) return
      const text = r.ok && r.value.source === 'host' ? r.value.summary.text : null
      setView(typeof text === 'string' && text ? { kind: 'text', text } : { kind: 'unavailable' })
    })
    return () => {
      live = false
    }
  }, [key, source, snapshot, data.unavailable])
  return view
}

/**
 * The watermark from before this visit: `tickets.seen` once per key while the page shows it, kept
 * for the visit so "since you last looked" doesn't collapse to zero on the next render.
 */
function usePreviousSeen(data: TicketData): number | null {
  const asked = useRef<string | null>(null)
  const [seen, setSeen] = useState<{ key: string; at: number | null } | null>(null)
  const ready = data.source === 'host' && data.detail !== null
  useEffect(() => {
    if (!ready || asked.current === data.key) return
    asked.current = data.key
    const key = data.key
    void invoke('tickets.seen', { key }).then((r) => {
      if (r.ok && r.value.source === 'host') setSeen({ key, at: r.value.previousSeenAt })
    })
  }, [ready, data.key])
  return seen?.key === data.key ? seen.at : null
}

function toastFailed(message: string): void {
  notifications.show({ id: TOAST_ID, color: 'red', message })
}

async function sendHandled(target: HandledTarget, undo: boolean): Promise<string | null> {
  const r = await invoke('tickets.handled', { target, undo })
  if (!r.ok) return r.error.message
  return r.value.source === 'host' ? null : r.value.message
}

/**
 * Mark as handled (Relay-only, the host's handled list; never a provider write). The line hides
 * at once; Undo brings it back. `show(false)` hides, `show(true)` restores.
 */
async function markHandled(
  target: HandledTarget,
  show: (on: boolean) => void,
  refresh: () => void,
): Promise<void> {
  show(false)
  const error = await sendHandled(target, false)
  if (error !== null) {
    show(true)
    return toastFailed(`Couldn't mark it as handled: ${error}`)
  }
  refresh()
  const undo = async (): Promise<void> => {
    notifications.hide(TOAST_ID)
    show(true)
    const e = await sendHandled(target, true)
    if (e !== null) {
      show(false)
      return toastFailed(`Couldn't bring it back: ${e}`)
    }
    refresh()
  }
  notifications.hide(TOAST_ID)
  notifications.show({
    id: TOAST_ID,
    autoClose: TOAST_MS,
    message: (
      <span className="eva-tk-toast">
        <span>Marked as handled</span>
        <Button
          variant="subtle"
          size="compact-sm"
          data-testid="ticket-handled-undo"
          onClick={() => void undo()}
        >
          Undo
        </Button>
      </span>
    ),
  })
}

function HandledButton({ onClick, testId }: { onClick: () => void; testId: string }) {
  return (
    <Tooltip label="Mark as handled" openDelay={300}>
      <ActionIcon
        variant="subtle"
        color="gray"
        size={24}
        aria-label="Mark as handled"
        data-testid={testId}
        onClick={onClick}
      >
        <IconCheck size={14} stroke={2} />
      </ActionIcon>
    </Tooltip>
  )
}

function WaitingRow({
  waiting,
  ticketKey,
  refresh,
}: {
  waiting: WaitingLine
  ticketKey: string
  refresh: () => void
}) {
  const replace = useReplacePlace()
  const [gone, setGone] = useState(false)
  if (gone) return null
  const first = waiting.author.name.trim().split(/\s+/)[0]
  const open = (): void => {
    if (waiting.pr) openPlace(ticketPlace(ticketKey, { pr: waiting.pr }))
    else replace(ticketPlace(ticketKey, { comment: waiting.commentId }))
  }
  const target: HandledTarget = {
    kind: 'mention',
    provider: waiting.provider,
    itemId: waiting.itemId,
    throughCommentId: waiting.commentId,
  }
  return (
    <div className="eva-tk-sum-row" data-testid="ticket-summary-waiting">
      <IconAt size={15} stroke={2} className="eva-tk-sum-at" aria-hidden />
      <PersonAvatar person={waiting.author} size={18} />
      <UnstyledButton className="eva-tk-sum-rowtext" onClick={open}>
        <b>
          {first} is waiting on your reply · {agoLabel(waiting.at, Date.now())}:
        </b>{' '}
        “{waiting.excerpt}”
      </UnstyledButton>
      <HandledButton
        onClick={() => void markHandled(target, (on) => setGone(!on), refresh)}
        testId="ticket-summary-waiting-handled"
      />
    </div>
  )
}

function NeedsRow({
  needs,
  ticketKey,
  refresh,
  onReply,
}: {
  needs: NeedsLine
  ticketKey: string
  refresh: () => void
  onReply: (() => void) | undefined
}) {
  const [gone, setGone] = useState(false)
  if (gone) return null
  const pr = needs.action.pr
  const action =
    needs.action.kind === 'reply'
      ? onReply
      : pr && (() => openPlace(ticketPlace(ticketKey, { pr })))
  const target: HandledTarget = {
    kind: 'needs',
    itemId: ticketKey,
    reasonKind: needs.kind,
    evidence: needs.evidence,
  }
  return (
    <div className="eva-tk-sum-row eva-tk-sum-needs" data-testid="ticket-summary-needs">
      <IconAlertCircleFilled size={16} className="eva-tk-sum-needs-i" aria-hidden />
      <span className="eva-tk-sum-rowtext">
        <b>Needs you:</b> {needs.text}
      </span>
      <HandledButton
        onClick={() => void markHandled(target, (on) => setGone(!on), refresh)}
        testId="ticket-summary-needs-handled"
      />
      {action ? (
        <Button size="compact-sm" onClick={action} data-testid="ticket-summary-needs-action">
          {needs.action.label}
        </Button>
      ) : null}
    </div>
  )
}

/** "Updated 2h ago · 3 comments since you last looked · PR #269 draft"; PRs open their route. */
function SummaryFooter({ data, card }: { data: TicketData; card: AgentCard | null }) {
  const previousSeenAt = usePreviousSeen(data)
  const { detail, key } = data
  const parts = footerText({
    updatedAt: detail?.updatedAt ?? card?.ticket?.updatedAt ?? null,
    now: Date.now(),
    comments: detail?.comments ?? [],
    previousSeenAt,
    meId: data.me.linearViewerId,
  })
  const prs = footerPrs(detail, card)
  return (
    <div className="eva-tk-sum-foot" data-testid="ticket-summary-footer">
      {parts.join(' · ')}
      {prs.map((pr, i) => (
        <span key={`${pr.repo}#${pr.number}`}>
          {parts.length > 0 || i > 0 ? ' · ' : ''}
          <UnstyledButton
            className="eva-tk-sum-link"
            onClick={() => openPlace(ticketPlace(key, { pr }))}
          >
            {pr.label}
          </UnstyledButton>
        </span>
      ))}
    </div>
  )
}

function SummaryBody({ view }: { view: SummaryView }) {
  if (view.kind === 'off') return null
  if (view.kind === 'loading') {
    return <Skeleton height={14} radius="sm" data-testid="ticket-summary-loading" />
  }
  if (view.kind === 'unavailable') {
    return (
      <div className="eva-tk-sum-muted" data-testid="ticket-summary-unavailable">
        Summary unavailable
      </div>
    )
  }
  return (
    <p className="eva-tk-sum-text" data-testid="ticket-summary-text">
      {view.text}
    </p>
  )
}

/**
 * The ticket page's top card: what waits on Isaac (the waiting mention and the one "Needs you"
 * thing, each clearable with Undo), the host's short summary and a facts footer.
 */
export function SummaryCard({
  data,
  card,
  onReply,
}: {
  data: TicketData
  card: AgentCard | null
  onReply?: () => void
}) {
  const view = useSummary(data)
  const { waiting, needs } = attentionLines(data.detail, card)
  return (
    <section className="eva-tk-sum" data-testid="ticket-summary">
      {waiting ? (
        <WaitingRow
          key={waiting.commentId}
          waiting={waiting}
          ticketKey={data.key}
          refresh={data.refresh}
        />
      ) : null}
      {view.kind === 'off' ? null : (
        <div className="eva-tk-sum-head">
          <IconSparkles size={14} stroke={1.75} aria-hidden />
          Summary
        </div>
      )}
      <SummaryBody view={view} />
      <SummaryFooter data={data} card={card} />
      {needs ? (
        <NeedsRow
          key={`${needs.kind}:${needs.evidence}`}
          needs={needs}
          ticketKey={data.key}
          refresh={data.refresh}
          onReply={onReply}
        />
      ) : null}
    </section>
  )
}
