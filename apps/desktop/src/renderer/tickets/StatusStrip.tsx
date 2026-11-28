import { useState } from 'react'
import { ActionIcon, Tooltip, UnstyledButton } from '@mantine/core'
import { IconAt, IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import type { AgentCard, ReviewPr } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { PR_ICON } from '../agents-board/CardChips'
import type { TicketPr } from '../agents-board/ticket-prs'
import { COLUMN_TITLE } from '../agents-board/board-view'
import { prSignalsFor, prStatusOf } from './pr-status'
import { prId, type TicketData } from './ticket-data'
import { ticketPlace, type TicketRef } from './ticket-place'

interface StripWaiting {
  name: string
  commentId: string
  pr: { repo: string; number: number } | null
}

/** The newest mention waiting on Isaac: the host's, else the synced card's. */
function waitingOf(data: TicketData, card: AgentCard | null): StripWaiting | null {
  const w = data.detail?.attention.waiting[0]
  if (w) {
    const pr = 'pr' in w.anchor ? w.anchor.pr : null
    return { name: w.author.name, commentId: w.commentId, pr }
  }
  const c = card?.ticket?.waiting
  return c ? { name: c.author.name, commentId: c.commentId, pr: c.anchor.pr } : null
}

/** Where a waiting mention opens: its PR, else its comment on the page. */
function waitingPlaceOf(at: TicketRef, w: StripWaiting): Place {
  const home = { item: at.kind === 'item' }
  return w.pr
    ? ticketPlace(at.id, { ...home, pr: w.pr })
    : ticketPlace(at.id, { ...home, comment: w.commentId })
}

function StateChip({ data, card }: { data: TicketData; card: AgentCard | null }) {
  const state = data.detail?.state ?? card?.ticket?.state ?? null
  if (state)
    return (
      <span className="eva-tk-strip-state" data-testid="ticket-strip-state">
        <i className="eva-tk-dot" style={{ background: state.color }} aria-hidden />
        {state.name}
      </span>
    )
  return card ? (
    <span className="eva-tk-strip-state" data-testid="ticket-strip-state">
      {COLUMN_TITLE[card.column]}
    </span>
  ) : null
}

function PrFacts({
  pr,
  data,
  card,
  read,
}: {
  pr: TicketPr
  data: TicketData
  card: AgentCard | null
  read: ReviewPr | null
}) {
  const status = prStatusOf(prSignalsFor(pr, data.detail?.prFacts ?? [], card, read))
  const Glyph = PR_ICON[pr.state ?? 'open']
  return (
    <>
      <span className="eva-tk-strip-pr" data-pr={pr.state ?? 'open'} data-testid="ticket-strip-pr">
        <Glyph size={14} stroke={1.75} aria-hidden />
        {pr.repo.split('/')[1]}#{pr.number}
      </span>
      <span className="eva-tk-strip-line" data-tone={status.tone} data-testid="ticket-strip-line">
        {status.line}
      </span>
      <span className="eva-tk-dim" data-testid="ticket-strip-checks">
        {status.checks}
      </span>
      {status.conflicts ? (
        <span className="eva-tk-dim" data-testid="ticket-strip-conflicts">
          {status.conflicts}
        </span>
      ) : null}
    </>
  )
}

/** "1 of n" over the page's PRs, by repo#number. */
function Stepper({
  index,
  count,
  onStep,
}: {
  index: number
  count: number
  onStep: (delta: -1 | 1) => void
}) {
  return (
    <span className="eva-tk-stepper" data-testid="ticket-strip-stepper">
      <Tooltip label="Previous pull request" openDelay={300}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={22}
          aria-label="Previous pull request"
          disabled={index === 0}
          onClick={() => onStep(-1)}
          data-testid="ticket-strip-prev"
        >
          <IconChevronLeft size={14} stroke={1.75} />
        </ActionIcon>
      </Tooltip>
      <span className="eva-tk-dim" data-testid="ticket-strip-pos">
        {index + 1} of {count}
      </span>
      <Tooltip label="Next pull request" openDelay={300}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size={22}
          aria-label="Next pull request"
          disabled={index >= count - 1}
          onClick={() => onStep(1)}
          data-testid="ticket-strip-next"
        >
          <IconChevronRight size={14} stroke={1.75} />
        </ActionIcon>
      </Tooltip>
    </span>
  )
}

/**
 * What the folded sidebar would have said, in one line under the top bar: the ticket's state, the
 * shown PR's state, why it can't merge, its checks and conflicts, and who waits on Isaac. With
 * several PRs a stepper picks which (the first by default; on a PR's page, that PR, and stepping
 * opens the next one's page). On a PR's page `read` is that page's PR read, so the strip and the
 * PR's sidebar say the same.
 */
export function StatusStrip({
  at,
  data,
  card,
  prs,
  go,
  read = null,
}: {
  at: TicketRef
  data: TicketData
  card: AgentCard | null
  prs: readonly TicketPr[]
  /** Shows another place in this tab (a PR's page, a comment). */
  go: (place: Place) => void
  /** The PR page's latest read of its PR, if any. */
  read?: ReviewPr | null
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const want = at.pr ? prId(at.pr) : picked
  const index = Math.max(
    0,
    prs.findIndex((p) => prId(p) === want),
  )
  const pr = prs[index] ?? null
  const waiting = waitingOf(data, card)
  const step = (delta: -1 | 1): void => {
    const next = prs[index + delta]
    if (!next) return
    if (at.pr) go(ticketPlace(at.id, { item: at.kind === 'item', pr: next }))
    else setPicked(prId(next))
  }
  return (
    <div className="eva-tk-strip" data-testid="ticket-strip">
      <StateChip data={data} card={card} />
      {pr ? (
        <PrFacts pr={pr} data={data} card={card} read={read} />
      ) : (
        <span className="eva-tk-dim">No pull request</span>
      )}
      {waiting ? (
        <UnstyledButton
          className="eva-tk-strip-wait"
          onClick={() => go(waitingPlaceOf(at, waiting))}
          data-testid="ticket-strip-waiting"
        >
          <IconAt size={13} stroke={2} aria-hidden />
          {waiting.name.trim().split(/\s+/)[0]} is waiting on you
        </UnstyledButton>
      ) : null}
      <span className="eva-tk-spacer" />
      {prs.length > 1 ? <Stepper index={index} count={prs.length} onStep={step} /> : null}
    </div>
  )
}
