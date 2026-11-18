import { UnstyledButton } from '@mantine/core'
import type { ReactNode } from 'react'
import { IconBellRinging, IconCircleDashed, IconLoader2, IconMoon } from '@tabler/icons-react'
import type { Assistant, AssistantStatus } from '@evaos/contract'
import { agoLabel } from '@evaos/eva-core/model/jobs'
import { placeOf } from '@evaos/shell-core'
import { openFromNav } from '../navigation/open-in-app'
import { portrait } from '../ui/portrait'
import { rowTip } from '../ui/list'
import './assistants-grid.css'

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

function Status({ a, now }: { a: Assistant; now: number }) {
  const ago = a.reply && a.reply.at !== null ? agoLabel(a.reply.at, now) : null
  return (
    <span
      className="eva-asg-status"
      data-status={a.status}
      data-testid={`assistant-status-${a.id}`}
    >
      {STATUS_ICON[a.status]}
      <span>{ago === null ? LABEL[a.status] : `${LABEL[a.status]} \u00b7 ${ago}`}</span>
    </span>
  )
}

/**
 * One bordered card per agent: its portrait fills the card, its name and status sit over the
 * foot. A click opens its thread (middle click opens it in a new tab).
 */
export function AssistantsGrid({ agents }: { agents: Assistant[] }) {
  const now = Date.now()
  return (
    <div className="eva-asg" data-testid="assistants-grid">
      {agents.map((a) => (
        <UnstyledButton
          key={a.id}
          className="eva-asg-card"
          data-testid={`assistant-row-${a.id}`}
          data-status={a.status}
          title={rowTip(a.title, a.scope, a.reply?.text)}
          onClick={(e) => openFromNav(placeOf(`agent:${a.id}`), e)}
          onAuxClick={(e) => {
            if (e.button === 1) openFromNav(placeOf(`agent:${a.id}`), e)
          }}
        >
          <span className="eva-asg-art" style={{ background: a.avatar.colors?.paper }}>
            <img
              src={portrait(a.avatar)}
              alt=""
              aria-hidden
              data-testid={`agent-portrait-${a.id}`}
            />
          </span>
          <span className="eva-asg-text">
            <span className="eva-asg-name">{a.title}</span>
            <Status a={a} now={now} />
          </span>
        </UnstyledButton>
      ))}
    </div>
  )
}
