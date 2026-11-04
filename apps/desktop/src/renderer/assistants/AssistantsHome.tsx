import { Avatar, Button } from '@mantine/core'
import { useState, type ReactNode } from 'react'
import {
  IconBellRinging,
  IconCircleDashed,
  IconLoader2,
  IconMessageChatbot,
  IconMoon,
  IconPlus,
} from '@tabler/icons-react'
import type { Assistant, AssistantStatus } from '@evaos/contract'
import { agoLabel } from '@evaos/eva-core/model/jobs'
import { placeOf, type Place } from '@evaos/shell-core'
import { openPlace } from '../navigation/navigate'
import { openFromNav } from '../navigation/open-in-app'
import { pageMeta } from '../pages/page-meta'
import { portrait } from '../ui/portrait'
import {
  ListEmpty,
  ListRow,
  ListStatus,
  ListTime,
  ListView,
  rowTip,
  type ListTone,
} from '../ui/list'
import { createAgent, useAssistants } from './assistants-store'
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
const ICON = { size: 16, stroke: 1.5, 'aria-hidden': true } as const
const STATUS_ICON: Record<AssistantStatus, ReactNode> = {
  working: <IconLoader2 {...ICON} className="eva-list-spin" />,
  'needs-you': <IconBellRinging {...ICON} />,
  idle: <IconMoon {...ICON} />,
  'not-started': <IconCircleDashed {...ICON} />,
}

/**
 * The Assistants home (native assistants_view::render): the heading with its subtext, then one
 * row per registry agent: its portrait (with its mood, PortraitMotion), its title, its status
 * mark and the age of its last reply. Scope and the reply itself are in the hover text.
 */
export function AssistantsHome({ place }: { place: Place }) {
  const data = useAssistants((s) => s.data)
  const meta = pageMeta(place)
  const now = Date.now()
  const [creating, setCreating] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  // One click: Relay Host adds "New assistant" and opens its thread; it gets to know Isaac by chatting.
  const create = (): void => {
    setCreating(true)
    setFailed(null)
    createAgent()
      .then((id) => openPlace(placeOf(`agent:${id}`)))
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
      .finally(() => setCreating(false))
  }
  return (
    <div className="eva-as-col" data-testid="assistants-home">
      <div className="eva-as-head">
        <div className="eva-as-head-row">
          <h1 className="eva-as-title">{meta.title}</h1>
          <Button
            variant="default"
            size="xs"
            leftSection={<IconPlus size={14} stroke={1.5} aria-hidden />}
            disabled={data?.relayUp !== true}
            title={data?.relayUp === true ? undefined : 'Relay is not connected'}
            loading={creating}
            onClick={create}
            data-testid="assistants-new"
          >
            New assistant
          </Button>
        </div>
        <p className="eva-as-dim">{meta.description}</p>
        {failed === null ? null : (
          <p className="eva-as-dim eva-as-error" data-testid="assistants-new-error">
            {failed}
          </p>
        )}
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
              title={a.title}
              tooltip={rowTip(a.title, a.scope, a.reply?.text)}
              trailing={
                <>
                  <ListStatus
                    label={STATUS_LABEL[a.status]}
                    tone={STATUS_TONE[a.status]}
                    icon={STATUS_ICON[a.status]}
                    data-testid={`assistant-status-${a.id}`}
                  />
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
              Create one with New assistant: it sets itself up in its first chat with you.
            </ListEmpty>
          }
        />
      )}
    </div>
  )
}
