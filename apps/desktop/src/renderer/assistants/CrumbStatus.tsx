import { useState } from 'react'
import { motionOff } from './motion-gate'
import { useAgentStatus } from './motion-store'

/**
 * The muted words after an agent's name in its crumb ("is thinking", "needs you", "hit a snag";
 * `rest` while it rests, else nothing). A change crossfades: the old words fade out over the new ones in the
 * same grid cell, so nothing beside them moves; with motion off they swap at once. Long words end
 * in an ellipsis.
 */
export function CrumbStatus({ id, rest = null }: { id: string; rest?: string | null }) {
  const text = useAgentStatus(id) ?? rest
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
