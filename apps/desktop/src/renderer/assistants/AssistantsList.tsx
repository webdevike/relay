import { placeOf } from '@evaos/shell-core'
import { openPlace } from '../navigation/navigate'
import { activePlace, useTabs } from '../tabs/tabs-store'
import { agentIdOf, useAssistants } from './assistants-store'
import './assistants.css'

/**
 * The sidebar's Assistants page (native assistants_view::sidebar_list): one row per agent, its
 * title over its scope, with a dot while Relay hears it working. The open agent is highlighted.
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
          onClick={(e) => openPlace(placeOf(`agent:${a.id}`), { newTab: e.metaKey })}
        >
          <span className="eva-as-side-text">
            <span className="eva-as-side-title">{a.title}</span>
            {a.scope ? <span className="eva-as-side-scope">{a.scope}</span> : null}
          </span>
          {a.status === 'working' ? (
            <span
              className="eva-as-dot"
              role="img"
              aria-label="Working"
              data-testid={`agent-working-${a.id}`}
            />
          ) : null}
        </button>
      ))}
    </div>
  )
}
