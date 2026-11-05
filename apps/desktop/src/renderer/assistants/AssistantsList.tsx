import { Avatar } from '@mantine/core'
import { placeOf } from '@evaos/shell-core'
import type { Assistant } from '@evaos/contract'
import { WorkspaceDot } from '../agent/WorkspaceDot'
import { openFromNav } from '../navigation/open-in-app'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { portrait } from '../ui/portrait'
import { ListRow, ListView, rowTip } from '../ui/list'
import { agentIdOf, useAssistants } from './assistants-store'
import { PortraitMotion } from './PortraitMotion'
import './assistants.css'

/**
 * The sidebar's Assistants page (native assistants_view::sidebar_list): one row per agent, its
 * portrait beside its title and scope. The portrait breathes with the agent's mood
 * (PortraitMotion). The open agent is highlighted.
 */
export function AssistantsList() {
  const agents = useAssistants((s) => s.data?.agents ?? null)
  const open = useTabs((s) => agentIdOf(activePlace(s)))
  if (agents === null) return null
  return (
    <ListView<Assistant>
      data-testid="assistants-list"
      density="compact"
      groups={[{ id: 'agents', items: agents }]}
      rowKey={(a) => a.id}
      renderRow={(a) => (
        <ListRow
          key={a.id}
          data-testid={`sidebar-agent-${a.id}`}
          active={open === a.id}
          aria-current={open === a.id ? 'page' : undefined}
          leading={
            <PortraitMotion id={a.id} testId={`sidebar-portrait-${a.id}`}>
              <Avatar
                className="eva-as-avatar"
                size="sm"
                radius="xl"
                src={portrait(a.avatar)}
                alt=""
                aria-hidden
              />
            </PortraitMotion>
          }
          title={a.title}
          trailing={<WorkspaceDot ws={`page:agent:${a.id}`} testId={`sidebar-dot-${a.id}`} />}
          tooltip={rowTip(a.title, a.scope)}
          onActivate={(e) => openFromNav(placeOf(`agent:${a.id}`), e)}
          middleClick
        />
      )}
    />
  )
}
