import type { KeyboardEvent } from 'react'
import { Tooltip } from '@mantine/core'
import {
  IconCircleCheck,
  IconCircleDashed,
  IconEye,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconGitPullRequestDraft,
  IconHandStop,
  IconLoader2,
  IconMessageCircle,
  IconProgress,
  IconRobot,
  IconSchema,
  IconTerminal2,
  type Icon,
} from '@tabler/icons-react'
import type { AgentCard, AgentColumn, AgentPr, ContextTone } from '@evaos/contract'
import { ListPill, type ListTone } from '../ui/list'
import { agoLabel } from './board-view'

export const COLUMN_ICON: Record<AgentColumn, Icon> = {
  queued: IconCircleDashed,
  working: IconProgress,
  needs: IconHandStop,
  review: IconEye,
  qa: IconGitMerge,
  done: IconCircleCheck,
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
  session: IconMessageCircle,
  helper: IconRobot,
  harness: IconTerminal2,
  canvas: IconSchema,
}

const PR_ICON: Record<NonNullable<AgentPr['state']>, Icon> = {
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

/** `react-client-reports-app#254, merged, checks passing`. */
export function prWords(pr: AgentPr): string {
  return [
    `${pr.repo.split('/')[1]}#${pr.number}`,
    pr.state,
    pr.decision === 'CHANGES_REQUESTED'
      ? 'changes requested'
      : pr.decision === 'APPROVED'
        ? 'approved'
        : null,
    pr.checks ? CHECKS_WORDS[pr.checks] : null,
  ]
    .filter(Boolean)
    .join(', ')
}

/** One card: key and age, the title, then its status pill, PR and the agent session on it. */
export function AgentCardView({
  card,
  now,
  active,
  onOpen,
}: {
  card: AgentCard
  now: number
  active: boolean
  onOpen: () => void
}) {
  const running = card.column === 'working'
  const Run = RUN_ICON[card.kind]
  const Pr = card.pr ? PR_ICON[card.pr.state ?? 'open'] : null
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    onOpen()
  }
  return (
    <div
      role="button"
      tabIndex={0}
      className="eva-ab-card"
      data-active={active || undefined}
      data-stale={card.stale || undefined}
      data-testid={`agents-card-${card.key ?? card.id}`}
      onClick={onOpen}
      onKeyDown={onKey}
    >
      <div className="eva-ab-cardtop">
        <span className="eva-ab-key">
          {card.key ?? (card.kind === 'helper' ? 'Helper' : 'Session')}
        </span>
        {card.activityAt !== null ? (
          <time className="eva-ab-age" dateTime={new Date(card.activityAt).toISOString()}>
            {agoLabel(card.activityAt, now)}
          </time>
        ) : null}
      </div>
      <div className="eva-ab-cardtitle">{card.title}</div>
      <div className="eva-ab-cardmeta">
        <Tooltip label={card.reason} openDelay={400} multiline maw={320}>
          <span className="eva-ab-pill">
            <ListPill
              tone={PILL_TONE[card.pill.tone]}
              icon={
                running ? (
                  <IconLoader2 size={12} className="eva-list-spin" aria-hidden />
                ) : undefined
              }
            >
              {card.pill.label}
            </ListPill>
          </span>
        </Tooltip>
        {card.pr && Pr ? (
          <Tooltip label={prWords(card.pr)} openDelay={400}>
            <span className="eva-ab-chip" data-pr={card.pr.state ?? 'unknown'}>
              <Pr size={14} stroke={1.75} aria-hidden />#{card.pr.number}
            </span>
          </Tooltip>
        ) : null}
        {card.session || card.agent ? (
          <Tooltip label={[card.agent, card.session].filter(Boolean).join(': ')} openDelay={400}>
            <span className="eva-ab-chip eva-ab-run">
              <Run size={14} stroke={1.5} aria-hidden />
              <span className="eva-ab-runname">{card.session ?? card.agent}</span>
            </span>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}
