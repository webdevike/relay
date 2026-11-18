import { useState } from 'react'
import { backgroundTasks } from '@relay/protocol'
import { agentOf, useAssistants } from './assistants-store'
import { motionOff } from './motion-gate'
import { useAgentStatus } from './motion-store'

/**
 * The muted words after an agent's name in its crumb ("is thinking", "needs you", "hit a snag";
 * `rest` while it rests, else nothing), with the count of background work it owns while it works
 * ("is working · 3 tasks"). A change crossfades: the old words fade out over the new ones in the
 * same grid cell, so nothing beside them moves; with motion off they swap at once. Long words end
 * in an ellipsis.
 */
export function CrumbStatus({ id, rest = null }: { id: string; rest?: string | null }) {
  const words = useAgentStatus(id)
  const tasks = useAssistants((s) => {
    const agent = agentOf(s, id)
    return agent?.status === 'working' ? backgroundTasks(agent.background) : null
  })
  const text = words === null ? rest : tasks === null ? words : `${words} \u00b7 ${tasks}`
  const [shown, setShown] = useState(text)
  const [leaving, setLeaving] = useState<string | null>(null)
  if (text !== shown) {
    setLeaving(motionOff() ? null : shown)
    setShown(text)
  }
  return (
    <span className="eva-as-crumb-status" data-testid="agent-crumb-status" aria-live="polite">
      {leaving === null ? null : (
        <span
          key={`out:${leaving}`}
          className="eva-as-crumb-status-text"
          data-leaving="true"
          aria-hidden
          onAnimationEnd={() => setLeaving(null)}
        >
          {leaving}
        </span>
      )}
      {shown === null ? null : (
        <span key={`in:${shown}`} className="eva-as-crumb-status-text">
          {shown}
        </span>
      )}
    </span>
  )
}
