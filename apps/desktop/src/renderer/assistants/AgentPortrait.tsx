import { portrait } from '../ui/portrait'
import { agentOf, useAssistants } from './assistants-store'
import { PortraitMotion } from './PortraitMotion'

/** Agent `id`'s portrait with its mood (PortraitMotion), decorative beside its name; sized by `className`. */
export function AgentPortrait({ id, className }: { id: string; className: string }) {
  // The id seeds it until the registry lists the agent (or once the registry drops it).
  const face = useAssistants((s) => agentOf(s, id)?.avatar ?? id)
  return (
    <PortraitMotion id={id} className={className} testId={`agent-portrait-${id}`}>
      <img src={portrait(face)} alt="" aria-hidden draggable={false} />
    </PortraitMotion>
  )
}
