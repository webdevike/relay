import type { Assistant } from '@evaos/contract'
import { agoLabel } from '@evaos/eva-core/model/jobs'
import { placeOf } from '@evaos/shell-core'
import { openFromNav } from '../navigation/open-in-app'
import { AssistantCard } from './AssistantCard'
import { troubleOf } from './agent-signin'
import './assistants-grid.css'

/**
 * One AssistantCard per agent: its portrait fills the card, its name and status sit over the
 * foot. A click opens its thread (middle click opens it in a new tab).
 */
export function AssistantsGrid({ agents }: { agents: Assistant[] }) {
  const now = Date.now()
  return (
    <div className="eva-asg" data-testid="assistants-grid">
      {agents.map((a) => (
        <AssistantCard
          key={a.id}
          data-testid={`assistant-row-${a.id}`}
          portraitTestId={`agent-portrait-${a.id}`}
          statusTestId={`assistant-status-${a.id}`}
          title={a.title}
          scope={a.scope}
          reply={a.reply?.text}
          status={a.status}
          background={a.background}
          age={a.reply && a.reply.at !== null ? agoLabel(a.reply.at, now) : null}
          face={a.avatar}
          trouble={troubleOf(a)}
          troubleTestId={`assistant-trouble-${a.id}`}
          onClick={(e) => openFromNav(placeOf(`agent:${a.id}`), e)}
          onAuxClick={(e) => {
            if (e.button === 1) openFromNav(placeOf(`agent:${a.id}`), e)
          }}
        />
      ))}
    </div>
  )
}
