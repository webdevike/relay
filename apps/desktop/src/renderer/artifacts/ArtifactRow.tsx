import type { MouseEvent, ReactNode } from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import {
  IconCircleCheck,
  IconCircleDashed,
  IconCircleDot,
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
  IconEyeSearch,
  IconLoader2,
  IconMessageExclamation,
  IconPencil,
  IconThumbUp,
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
  type Tone,
} from './artifacts-model'
import { ListMarks, ListRow, rowTip, type ListTone } from '../ui/list'

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

/** The model's pill colors as list tones (orange reads as a warning). */
const PILL_TONE: Record<Tone, ListTone> = {
  gray: 'dim',
  blue: 'info',
  yellow: 'warn',
  orange: 'warn',
  green: 'ok',
  red: 'bad',
  violet: 'accent',
}

/** A PR's or issue's own icon per state, review and check result; a ticket's state keeps its tone's. */
const STATUS_ICON: Record<string, ReactNode> = {
  Merged: <IconGitMerge {...ICON} />,
  Closed: <IconGitPullRequestClosed {...ICON} />,
  Draft: <IconPencil {...ICON} />,
  'Changes requested': <IconMessageExclamation {...ICON} />,
  'Review required': <IconEyeSearch {...ICON} />,
  Approved: <IconThumbUp {...ICON} />,
  Open: <IconCircleDot {...ICON} />,
  'Checks failing': <IconCircleX {...ICON} />,
  'Checks running': <IconLoader2 {...ICON} className="eva-list-spin" />,
  'Checks pass': <IconCircleCheck {...ICON} />,
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
 * One thing the thread holds, as a flat divided row: its key and title, and its live state as
 * one status mark. How often and when it came up (or who pinned it), the repo and linked
 * tickets are in the hover text, with open, open elsewhere, pin and more.
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
  // Two slots, the same on every row: the item's state or review, then its checks.
  const state = pills.find((p) => !p.label.startsWith('Checks'))
  const checks = pills.find((p) => p.label.startsWith('Checks'))
  const target = openTarget(item)
  const external = externalUrl(item)
  return (
    <ListRow
      data-testid={`artifact-row-${item.id}`}
      tooltip={rowTip([key, title].filter(Boolean).join(' '), meta.join(' · '))}
      leading={<KindIcon item={item} />}
      title={
        <>
          {key !== null ? <span className="eva-art-key">{key}</span> : null}
          {title}
        </>
      }
      trailing={
        pills.length > 0 ? (
          <ListMarks
            slots={[state, checks].map((p) =>
              p ? { label: p.label, tone: PILL_TONE[p.tone], icon: STATUS_ICON[p.label] } : null,
            )}
          />
        ) : undefined
      }
      onActivate={(e) => actions.open(item, openTargetOf(e))}
      middleClick
      onMenu={(x, y) => actions.menu(item, x, y)}
      actions={
        <>
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
        </>
      }
    />
  )
}
