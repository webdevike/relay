import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { Avatar, Tooltip, UnstyledButton } from '@mantine/core'
import {
  IconAlertSquareFilled,
  IconBox,
  IconChevronRight,
  IconCircle,
  IconCircleCheck,
  IconCircleCheckFilled,
  IconCircleDashed,
  IconCircleDot,
  IconCircleHalf2,
  IconCircleXFilled,
  IconDots,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconGitPullRequestDraft,
  IconMessageCircle,
  IconRobot,
  IconSchema,
  IconTerminal2,
  IconTicket,
  type Icon,
} from '@tabler/icons-react'
import type { AgentCard, AgentColumn, AgentPr, ContextTone } from '@evaos/contract'
import type { ListTone } from '../ui/list'
import type { CardTicket } from './board-view'

// The small pieces of a board card, after Linear's board: a status circle, priority bars, the
// sub-issue ring and one chip per project, PR, label and session; plus the glyphs the ticket
// page shares.

/** Column glyphs, colored per column in agents-board.css (the shape carries it without color). */
export const COLUMN_ICON: Record<AgentColumn, Icon> = {
  queued: IconCircleDashed,
  working: IconCircleHalf2,
  needs: IconCircleDot,
  review: IconCircleHalf2,
  qa: IconCircleCheck,
  done: IconCircleCheckFilled,
}

export const PILL_TONE: Record<ContextTone, ListTone> = {
  default: 'dim',
  success: 'ok',
  danger: 'bad',
  warning: 'warn',
  info: 'info',
}

export const RUN_ICON: Record<AgentCard['kind'], Icon> = {
  item: IconMessageCircle,
  ticket: IconTicket,
  session: IconMessageCircle,
  helper: IconRobot,
  harness: IconTerminal2,
  canvas: IconSchema,
}

export const PR_ICON: Record<NonNullable<AgentPr['state']>, Icon> = {
  open: IconGitPullRequest,
  draft: IconGitPullRequestDraft,
  merged: IconGitMerge,
  closed: IconGitPullRequestClosed,
}

const CHECKS_WORDS: Record<NonNullable<AgentPr['checks']>, string | null> = {
  pass: 'checks passing',
  fail: 'checks failing',
  pending: 'checks running',
  none: null,
}

const DECISION_WORDS: Record<string, string> = {
  CHANGES_REQUESTED: 'changes requested',
  APPROVED: 'approved',
}

type ChipPr = Pick<AgentPr, 'repo' | 'number' | 'state' | 'checks' | 'decision'>

/** `react-client-reports-app#254, merged, checks passing`. */
export function prWords(pr: ChipPr): string {
  return [
    `${pr.repo.split('/')[1]}#${pr.number}`,
    pr.state,
    pr.decision ? DECISION_WORDS[pr.decision] : null,
    pr.checks ? CHECKS_WORDS[pr.checks] : null,
  ]
    .filter(Boolean)
    .join(', ')
}

/** Keeps a nested control's keys (Enter, Space) off the card under it. */
export const stopKeys = (e: KeyboardEvent): void => e.stopPropagation()

/** A person's face, or their initials on a color picked from the name. */
export function PersonAvatar({
  person,
  size,
}: {
  person: { name: string; avatarUrl: string | null }
  size: number
}) {
  return (
    <Avatar
      src={person.avatarUrl}
      name={person.name}
      color="initials"
      variant="filled"
      size={size}
      radius="xl"
      className="eva-ab-avatar"
      alt={person.name}
    />
  )
}

const STATE_ICON: Record<string, Icon> = {
  triage: IconCircleDashed,
  backlog: IconCircleDashed,
  unstarted: IconCircle,
  started: IconCircleHalf2,
  completed: IconCircleCheckFilled,
  canceled: IconCircleXFilled,
}

/** The status circle before the title: the Linear state's shape and color, else the column's. */
export function StatusCircle({ card }: { card: AgentCard }) {
  const state = card.ticket?.state ?? null
  if (state === null) {
    const Glyph = COLUMN_ICON[card.column]
    return (
      <span className="eva-ab-status" data-column={card.column}>
        <Glyph size={15} stroke={1.75} aria-hidden />
      </span>
    )
  }
  const Glyph = STATE_ICON[state.type] ?? IconCircle
  return (
    <Tooltip label={state.name} openDelay={400}>
      <span className="eva-ab-status" style={{ color: state.color }}>
        <Glyph size={15} stroke={1.75} aria-label={state.name} />
      </span>
    </Tooltip>
  )
}

const PRIORITY = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const

/** Linear's priority: a filled alert for Urgent, three bars filling High to Low, dots for none. */
function PriorityGlyph({ level }: { level: number }) {
  if (level === 0) return <IconDots size={12} stroke={1.75} aria-hidden />
  if (level === 1) return <IconAlertSquareFilled size={12} className="eva-ab-urgent" aria-hidden />
  const bars = 5 - level
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={1 + i * 4}
          y={8 - i * 3}
          width="2.5"
          height={3 + i * 3}
          rx="0.8"
          fill="currentColor"
          opacity={i < bars ? 1 : 0.3}
        />
      ))}
    </svg>
  )
}

/** Sub-issues done of all, as a filling ring. */
function SubRing({ done, total }: { done: number; total: number }) {
  const r = 4.5
  const c = 2 * Math.PI * r
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <circle
        cx="6"
        cy="6"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="1.5"
      />
      <circle
        cx="6"
        cy="6"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={`${(done / Math.max(total, 1)) * c} ${c}`}
        transform="rotate(-90 6 6)"
      />
    </svg>
  )
}

/** Row one: the key, its parent's key, and whose it is. */
export function CardKeyRow({ card }: { card: AgentCard }) {
  const parent = card.ticket?.parent ?? null
  const who = card.ticket?.assignee ?? (card.agent ? { name: card.agent, avatarUrl: null } : null)
  return (
    <div className="eva-ab-r1">
      <span className="eva-ab-key">{card.key ?? KIND_WORD[card.kind]}</span>
      {parent ? (
        <Tooltip label={parent.title} openDelay={400} multiline maw={320}>
          <span className="eva-ab-parent">
            <IconChevronRight size={12} stroke={1.75} aria-hidden />
            {parent.key}
          </span>
        </Tooltip>
      ) : null}
      <span className="eva-ab-spacer" />
      {who ? (
        <Tooltip label={who.name} openDelay={400}>
          <span className="eva-ab-who">
            <PersonAvatar person={who} size={20} />
          </span>
        </Tooltip>
      ) : null}
    </div>
  )
}

const KIND_WORD: Record<AgentCard['kind'], string> = {
  item: 'Work item',
  ticket: 'Ticket',
  helper: 'Helper',
  session: 'Session',
  harness: 'Harness',
  canvas: 'Canvas',
}

/** The PRs a card links: the ticket's (Linear attachments), else the card's own. */
function prsOf(card: AgentCard): ChipPr[] {
  if (card.ticket && card.ticket.prs.length > 0) return card.ticket.prs
  return card.pr ? [card.pr] : []
}

function PrChip({ pr, onOpen }: { pr: ChipPr; onOpen: (pr: ChipPr) => void }) {
  const Glyph = PR_ICON[pr.state ?? 'open']
  return (
    <Tooltip label={prWords(pr)} openDelay={400}>
      <UnstyledButton
        className="eva-ab-chip eva-ab-chip-btn"
        data-pr={pr.state ?? 'unknown'}
        data-testid={`agents-pr-${pr.number}`}
        onKeyDown={stopKeys}
        onClick={(e: MouseEvent) => {
          e.stopPropagation()
          onOpen(pr)
        }}
      >
        <Glyph size={12} stroke={1.75} aria-hidden />#{pr.number}
      </UnstyledButton>
    </Tooltip>
  )
}

/** Priority and project: the ticket's chips before its PRs. */
function TicketHead({ t }: { t: CardTicket }) {
  return (
    <>
      <Tooltip label={PRIORITY[t.priority]} openDelay={400}>
        <span className="eva-ab-chip" aria-label={PRIORITY[t.priority]}>
          <PriorityGlyph level={t.priority} />
        </span>
      </Tooltip>
      {t.project ? (
        <span className="eva-ab-chip">
          <IconBox size={12} stroke={1.75} aria-hidden />
          <span className="eva-ab-chip-t">{t.project.name}</span>
        </span>
      ) : null}
    </>
  )
}

/** Sub-issues and labels: the ticket's chips after its PRs. */
function TicketTail({ t }: { t: CardTicket }) {
  return (
    <>
      {t.sub && t.sub.total > 0 ? (
        <span
          className="eva-ab-chip"
          aria-label={`${t.sub.done} of ${t.sub.total} sub-issues done`}
        >
          <SubRing done={t.sub.done} total={t.sub.total} />
          {t.sub.done}/{t.sub.total}
        </span>
      ) : null}
      {t.labels.map((l) => (
        <span key={l.name} className="eva-ab-chip">
          <i className="eva-ab-dot" style={{ background: l.color }} aria-hidden />
          <span className="eva-ab-chip-t">{l.name}</span>
        </span>
      ))}
    </>
  )
}

/**
 * Everything under the title but the waiting chip: `lead` (the agent's stage pill), priority,
 * project, PRs, sub-issues, labels, session.
 */
export function CardChips({
  card,
  onOpenPr,
  lead,
}: {
  card: AgentCard
  onOpenPr: (pr: { repo: string; number: number }) => void
  lead?: ReactNode
}) {
  const t = card.ticket
  const Run = RUN_ICON[card.kind]
  const prs = prsOf(card)
  const session = card.key === null ? card.session : null
  if (!lead && !t && prs.length === 0 && session === null) return null
  return (
    <div className="eva-ab-chips">
      {lead}
      {t ? <TicketHead t={t} /> : null}
      {prs.map((pr) => (
        <PrChip key={`${pr.repo}#${pr.number}`} pr={pr} onOpen={onOpenPr} />
      ))}
      {t ? <TicketTail t={t} /> : null}
      {session !== null ? (
        <span className="eva-ab-chip" data-testid="agents-session-chip">
          <Run size={12} stroke={1.75} aria-hidden />
          <span className="eva-ab-chip-t">{session}</span>
        </span>
      ) : null}
    </div>
  )
}
