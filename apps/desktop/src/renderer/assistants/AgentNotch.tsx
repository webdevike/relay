import { AgentPortrait } from './AgentPortrait'
import { CrumbStatus } from './CrumbStatus'
import './assistants.css'

/**
 * The agent's face in its page header, centered on the seam like the mobile notch: the animated
 * portrait and, muted beside it, what it is doing (nothing while it rests). Display only; the
 * header stays draggable through it.
 */
export function AgentNotch({ id }: { id: string }) {
  return (
    <span className="eva-as-notch" data-testid="agent-notch">
      <AgentPortrait id={id} className="eva-as-crumb-portrait" />
      <CrumbStatus id={id} />
    </span>
  )
}
