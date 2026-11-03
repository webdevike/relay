import { Avatar } from '@mantine/core'
import { IconMessageChatbot } from '@tabler/icons-react'
import type { Assistant, AssistantStatus } from '@evaos/contract'
import { agoLabel } from '@evaos/eva-core/model/jobs'
import { placeOf, type Place } from '@evaos/shell-core'
import { openFromNav } from '../navigation/open-in-app'
import { pageMeta } from '../pages/page-meta'
import { portrait } from '../ui/portrait'
import { ListEmpty, ListPill, ListRow, ListTime, ListView, type ListTone } from '../ui/list'
import { useAssistants } from './assistants-store'
import { PortraitMotion } from './PortraitMotion'
import './assistants.css'

const STATUS_LABEL: Record<AssistantStatus, string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  idle: 'Idle',
  'not-started': 'Not started',
}
const STATUS_TONE: Record<AssistantStatus, ListTone> = {
  working: 'info',
  'needs-you': 'warn',
  idle: 'dim',
  'not-started': 'dim',
}

/**
 * The Assistants home (native assistants_view::render): the heading with its subtext, then one
 * row per registry agent: its portrait (with its mood, PortraitMotion), title and scope, last
 * reply, its age and status.
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
      {data === null ? null : (
        <ListView<Assistant>
          groups={[{ id: 'agents', items: data.agents }]}
          rowKey={(a) => a.id}
          renderRow={(a) => (
            <ListRow
              key={a.id}
              data-testid={`assistant-row-${a.id}`}
              data-status={a.status}
              tile={false}
              leading={
                <PortraitMotion id={a.id} testId={`agent-portrait-${a.id}`}>
                  <Avatar
                    className="eva-as-avatar"
                    size="md"
                    radius="xl"
                    src={portrait(a.avatar)}
                    alt=""
                    aria-hidden
                  />
                </PortraitMotion>
              }
              title={
                <>
                  {a.title}
                  {a.scope ? <span className="eva-as-row-scope">{a.scope}</span> : null}
                </>
              }
              meta={
                a.reply ? (
                  <span data-testid={`assistant-reply-${a.id}`}>{a.reply.text}</span>
                ) : undefined
              }
              trailing={
                <>
                  <ListPill tone={STATUS_TONE[a.status]} data-testid={`assistant-status-${a.id}`}>
                    {STATUS_LABEL[a.status]}
                  </ListPill>
                  <ListTime>
                    {a.reply && a.reply.at !== null ? agoLabel(a.reply.at, now) : null}
                  </ListTime>
                </>
              }
              onActivate={(e) => openFromNav(placeOf(`agent:${a.id}`), e)}
              middleClick
            />
          )}
          empty={
            <ListEmpty
              data-testid="assistants-empty"
              icon={<IconMessageChatbot size={28} stroke={1.5} aria-hidden />}
              title="No assistants yet"
            >
              Add agents to .omp/assistant/agents.json and they appear here.
            </ListEmpty>
          }
        />
      )}
    </div>
  )
}
