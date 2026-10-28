import { portrait } from '../ui/portrait'
import { agentOf, useAssistants } from './assistants-store'

/** Agent `id`'s portrait, decorative beside its name; sized by `className`. */
export function AgentPortrait({ id, className }: { id: string; className: string }) {
  // The id seeds it until the registry lists the agent (or once the registry drops it).
  const face = useAssistants((s) => agentOf(s, id)?.avatar ?? id)
  return (
    <img
      className={className}
      src={portrait(face)}
      alt=""
      aria-hidden
      draggable={false}
      data-testid={`agent-portrait-${id}`}
    />
  )
}
