import type { MouseEvent, ReactNode } from 'react'
import { ActionIcon, Badge, Tooltip } from '@mantine/core'
import {
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconDots,
  IconExternalLink,
  IconFile,
  IconFlask,
  IconGitBranch,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconGitPullRequestDraft,
  IconLayoutBoard,
  IconLayoutSidebarRight,
  IconPhoto,
  IconPin,
  IconPinnedOff,
  IconProgress,
  IconSubtask,
  IconTicket,
  IconWorld,
} from '@tabler/icons-react'
import type { Artifact } from '@evaos/chat-core/artifacts'
import { openTargetOf, type OpenTarget } from '../navigation/open-target'
import {
  externalUrl,
  itemKey,
  itemTitle,
  linkedText,
  openTarget,
  repoName,
  seenText,
  statusPills,
  type Pill,
} from './artifacts-model'

const ICON = { size: 16, stroke: 1.5 } as const

/** A row's leading icon: its kind, shaped by its state (a ticket's category, a PR's draft or merge). */
export function KindIcon({ item }: { item: Artifact }) {
  const s = item.status
  switch (item.kind) {
    case 'linear':
      if (s?.stateType === 'completed') return <IconCircleCheck {...ICON} data-tone="green" />
      if (s?.stateType === 'canceled') return <IconCircleX {...ICON} />
      if (s?.stateType === 'started') return <IconProgress {...ICON} data-tone="yellow" />
      if (s?.stateType === 'unstarted' || s?.stateType === 'backlog')
        return <IconCircleDashed {...ICON} />
      return <IconTicket {...ICON} />
    case 'gh-pr':
      if (s?.state === 'merged') return <IconGitMerge {...ICON} data-tone="violet" />
      if (s?.state === 'closed') return <IconGitPullRequestClosed {...ICON} />
      if (s?.draft) return <IconGitPullRequestDraft {...ICON} />
      return <IconGitPullRequest {...ICON} data-tone={s ? 'green' : undefined} />
    case 'gh-issue':
      return <IconCircleDashed {...ICON} data-tone={s?.state === 'open' ? 'green' : undefined} />
    case 'branch':
      return <IconGitBranch {...ICON} />
    case 'url':
      return <IconWorld {...ICON} />
    case 'file':
      return item.media ? <IconPhoto {...ICON} /> : <IconFile {...ICON} />
    case 'experiment':
      return <IconFlask {...ICON} />
    case 'canvas':
      return <IconLayoutBoard {...ICON} />
    case 'subagent':
      return <IconSubtask {...ICON} />
    default:
      return <IconPhoto {...ICON} />
  }
}

export function StatusPill({ pill }: { pill: Pill }) {
  return (
    <Badge
      className="eva-art-pill"
      variant="light"
      color={pill.tone}
      radius="sm"
      size="sm"
      tt="none"
      data-tone={pill.tone}
    >
      {pill.label}
    </Badge>
  )
}

/** "Open in Linear", "Open on GitHub", or the browser for anything else. */
function externalLabel(item: Artifact): string {
  if (item.kind === 'linear') return 'Open in Linear'
  if (item.kind === 'gh-pr' || item.kind === 'gh-issue' || item.kind === 'branch')
    return 'Open on GitHub'
  return 'Open in your browser'
}

export interface RowActions {
  /** `target`: where an in-app destination (a canvas, the Test Bench) opens; default a split. */
  open(item: Artifact, target?: OpenTarget): void
  external(url: string): void
  pin(item: Artifact, pinned: boolean): void
  /** The row's menu at a point (copy its link or path, show it in Files). */
  menu(item: Artifact, x: number, y: number): void
}

export function RowButton({
  label,
  onClick,
  children,
  testid,
}: {
  label: string
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
  testid?: string
}) {
  return (
    <Tooltip label={label} openDelay={400} position="top">
      <ActionIcon
        variant="subtle"
        color="gray"
        size="sm"
        aria-label={label}
        data-testid={testid}
        onClick={(e) => {
          e.stopPropagation()
          onClick(e)
        }}
      >
        {children}
      </ActionIcon>
    </Tooltip>
  )
}

/**
 * One thing the thread holds, as a flat divided row: its key and title, how often and when it
 * came up (or who pinned it), and its live state as quiet pills. Hover shows open, open
 * elsewhere, pin and more.
 */
export function ArtifactRow({
  item,
  byId,
  now,
  pinnedBy,
  actions,
}: {
  item: Artifact
  byId: ReadonlyMap<string, Artifact>
  now: number
  /** "you" or an agent's name, for a pinned row. */
  pinnedBy: string | null
  actions: RowActions
}) {
  const key = itemKey(item)
  const title = itemTitle(item)
  const linked = item.kind === 'gh-pr' ? linkedText(item, byId) : null
  const meta = [
    item.kind === 'gh-pr' || item.kind === 'gh-issue' || item.kind === 'branch'
      ? repoName(item)
      : null,
    linked,
    pinnedBy !== null ? `pinned by ${pinnedBy}` : seenText(item, now),
  ].filter((x): x is string => x !== null)
  const pills = statusPills(item)
  const target = openTarget(item)
  const external = externalUrl(item)
  return (
    <div
      className="eva-art-row"
      role="button"
      tabIndex={0}
      data-testid={`artifact-row-${item.id}`}
      onClick={(e) => actions.open(item, openTargetOf(e))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') actions.open(item)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        actions.menu(item, e.clientX, e.clientY)
      }}
    >
      <span className="eva-art-row-icon">
        <KindIcon item={item} />
      </span>
      <span className="eva-art-row-text">
        <span className="eva-art-row-title">
          {key !== null ? <span className="eva-art-key">{key}</span> : null}
          {title !== '' ? <span className="eva-art-title-text">{title}</span> : null}
        </span>
        <span className="eva-art-row-meta">{meta.join(' · ')}</span>
      </span>
      {pills.length > 0 ? (
        <span className="eva-art-pills">
          {pills.map((p) => (
            <StatusPill key={p.label} pill={p} />
          ))}
        </span>
      ) : null}
      <span className="eva-art-row-actions">
        {target?.to === 'browser' ? (
          <RowButton
            label="Open in the browser panel"
            onClick={(e) => actions.open(item, openTargetOf(e))}
          >
            <IconLayoutSidebarRight {...ICON} />
          </RowButton>
        ) : null}
        {external !== null ? (
          <RowButton label={externalLabel(item)} onClick={() => actions.external(external)}>
            <IconExternalLink {...ICON} />
          </RowButton>
        ) : null}
        <RowButton
          label={item.pinned ? 'Unpin' : 'Pin to the top'}
          testid={`artifact-pin-${item.id}`}
          onClick={() => actions.pin(item, item.pinned === undefined)}
        >
          {item.pinned ? <IconPinnedOff {...ICON} /> : <IconPin {...ICON} />}
        </RowButton>
        <RowButton
          label="More"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            actions.menu(item, r.left, r.bottom)
          }}
        >
          <IconDots {...ICON} />
        </RowButton>
      </span>
    </div>
  )
}
