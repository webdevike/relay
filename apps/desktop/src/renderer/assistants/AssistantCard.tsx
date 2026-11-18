import { UnstyledButton } from '@mantine/core'
import type { MouseEvent, ReactNode } from 'react'
import { IconBellRinging, IconCircleDashed, IconLoader2, IconMoon } from '@tabler/icons-react'
import type { AssistantPortrait, AssistantStatus } from '@evaos/contract'
import { backgroundTasks } from '@relay/protocol'
import { portrait } from '../ui/portrait'
import { rowTip } from '../ui/list/ListRow'

const LABEL: Record<AssistantStatus, string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  idle: 'Idle',
  'not-started': 'Not started',
}
const ICON = { size: 14, stroke: 1.5, 'aria-hidden': true } as const
const STATUS_ICON: Record<AssistantStatus, ReactNode> = {
  working: <IconLoader2 {...ICON} className="eva-list-spin" />,
  'needs-you': <IconBellRinging {...ICON} />,
  idle: <IconMoon {...ICON} />,
  'not-started': <IconCircleDashed {...ICON} />,
}

export interface AssistantCardProps {
  title: string
  /** What it looks after; in the hover text. */
  scope?: string | undefined
  /** Its last reply's words; in the hover text. */
  reply?: string | undefined
  status: AssistantStatus
  /** Work it owns that runs besides its own turn: a working card counts it ("Working · 3 tasks"). */
  background?: number | undefined
  /** How long ago it last replied ("5m"), after the status label when no count shows. */
  age?: string | null | undefined
  /** A notionists seed, or a designed portrait (its paper fills the card behind it). */
  face: string | AssistantPortrait
  onClick?: ((e: MouseEvent<HTMLButtonElement>) => void) | undefined
  onAuxClick?: ((e: MouseEvent<HTMLButtonElement>) => void) | undefined
  'data-testid'?: string | undefined
  portraitTestId?: string | undefined
  statusTestId?: string | undefined
}

/**
 * One assistant as a bordered cover card (assistants-grid.css, imported by its users): its
 * portrait fills the card, its name and status sit over the foot. Presentational: AssistantsGrid
 * feeds it the registry, and the `relay` design system's kit draws the same component.
 */
export function AssistantCard({
  title,
  scope,
  reply,
  status,
  background,
  age,
  face,
  onClick,
  onAuxClick,
  'data-testid': testId,
  portraitTestId,
  statusTestId,
}: AssistantCardProps) {
  const paper = typeof face === 'string' ? undefined : face.colors?.paper
  const after = (status === 'working' ? backgroundTasks(background) : null) ?? age
  return (
    <UnstyledButton
      className="eva-asg-card"
      data-testid={testId}
      data-status={status}
      title={rowTip(title, scope, reply)}
      onClick={onClick}
      onAuxClick={onAuxClick}
    >
      <span className="eva-asg-art" style={{ background: paper }}>
        <img src={portrait(face)} alt="" aria-hidden data-testid={portraitTestId} />
      </span>
      <span className="eva-asg-text">
        <span className="eva-asg-name">{title}</span>
        <span className="eva-asg-status" data-status={status} data-testid={statusTestId}>
          {STATUS_ICON[status]}
          <span>{after == null ? LABEL[status] : `${LABEL[status]} \u00b7 ${after}`}</span>
        </span>
      </span>
    </UnstyledButton>
  )
}
