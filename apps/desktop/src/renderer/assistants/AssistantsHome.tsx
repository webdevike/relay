import { Avatar } from '@mantine/core'
import { IconRobot } from '@tabler/icons-react'
import type { AssistantStatus } from '@evaos/contract'
import { agoLabel } from '@evaos/eva-core/model/jobs'
import { placeOf, type Place } from '@evaos/shell-core'
import { openPlace } from '../navigation/navigate'
import { pageMeta } from '../pages/page-meta'
import { portrait } from '../ui/portrait'
import { useAssistants } from './assistants-store'
import './assistants.css'

const STATUS_LABEL: Record<AssistantStatus, string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  idle: 'Idle',
  'not-started': 'Not started',
}

/**
 * The Assistants home (native assistants_view::render): the heading with its subtext, then one
 * divided row per registry agent: its portrait, title, scope, last reply with its age and status.
 */
export function AssistantsHome({ place }: { place: Place }) {
  const data = useAssistants((s) => s.data)
  const meta = pageMeta(place)
  const now = Date.now()
  return (
    <div className="eva-as-col" data-testid="assistants-home">
      <div className="eva-as-head">
        <h1 className="eva-as-title">{meta.title}</h1>
        <p className="eva-as-dim">{meta.description}</p>
      </div>
      {data === null ? null : data.agents.length === 0 ? (
        <div className="eva-as-empty" data-testid="assistants-empty">
          <IconRobot size={28} stroke={1.5} aria-hidden />
          <div className="eva-as-empty-title">No assistants yet</div>
          <p className="eva-as-dim">
            Add agents to .omp/assistant/agents.json and they appear here.
          </p>
        </div>
      ) : (
        <div className="eva-as-rows">
          {data.agents.map((a) => (
            <button
              key={a.id}
              type="button"
              className="eva-as-row"
              data-testid={`assistant-row-${a.id}`}
              data-status={a.status}
              onClick={(e) => openPlace(placeOf(`agent:${a.id}`), { newTab: e.metaKey })}
            >
              <Avatar
                className="eva-as-avatar"
                size="md"
                radius="xl"
                src={portrait(a.avatar)}
                alt=""
                aria-hidden
                data-testid={`agent-portrait-${a.id}`}
              />
              <span className="eva-as-row-text">
                <span className="eva-as-row-line">
                  <span className="eva-as-row-title">{a.title}</span>
                  {a.scope ? <span className="eva-as-row-scope">{a.scope}</span> : null}
                </span>
                {a.reply ? (
                  <span className="eva-as-row-line">
                    <span className="eva-as-row-reply" data-testid={`assistant-reply-${a.id}`}>
                      {a.reply.text}
                    </span>
                    {a.reply.at !== null ? (
                      <span className="eva-as-row-age">{agoLabel(a.reply.at, now)}</span>
                    ) : null}
                  </span>
                ) : null}
              </span>
              <span
                className="eva-as-pill"
                data-status={a.status}
                data-testid={`assistant-status-${a.id}`}
              >
                {STATUS_LABEL[a.status]}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
