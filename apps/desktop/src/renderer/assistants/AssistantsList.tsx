import { Avatar } from '@mantine/core'
import { placeOf } from '@evaos/shell-core'
import { openFromNav } from '../navigation/open-in-app'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { portrait } from '../ui/portrait'
import { agentIdOf, useAssistants } from './assistants-store'
import { PortraitMotion } from './PortraitMotion'
import './assistants.css'

/**
 * The sidebar's Assistants page (native assistants_view::sidebar_list): one row per agent, its
 * portrait beside its title over its scope. The portrait breathes with the agent's mood
 * (PortraitMotion). The open agent is highlighted.
 */
export function AssistantsList() {
  const agents = useAssistants((s) => s.data?.agents ?? null)
  const open = useTabs((s) => agentIdOf(activePlace(s)))
  if (agents === null) return null
  return (
    <div className="eva-as-side" data-testid="assistants-list">
      {agents.map((a) => (
        <button
          key={a.id}
          type="button"
          className="eva-sb-row eva-as-side-row"
          data-testid={`sidebar-agent-${a.id}`}
          data-active={open === a.id ? 'true' : undefined}
          aria-current={open === a.id ? 'page' : undefined}
          onClick={(e) => openFromNav(placeOf(`agent:${a.id}`), e)}
          onAuxClick={(e) => {
            if (e.button !== 1) return
            e.preventDefault()
            openFromNav(placeOf(`agent:${a.id}`), e)
          }}
        >
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
          <span className="eva-as-side-text">
            <span className="eva-as-side-title">{a.title}</span>
            {a.scope ? <span className="eva-as-side-scope">{a.scope}</span> : null}
          </span>
        </button>
      ))}
    </div>
  )
}
