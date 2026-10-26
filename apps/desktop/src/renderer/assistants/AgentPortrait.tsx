import { portrait } from '../ui/portrait'
import { agentOf, useAssistants } from './assistants-store'

/** Agent `id`'s notionists portrait, decorative beside its name; sized by `className`. */
export function AgentPortrait({ id, className }: { id: string; className: string }) {
  // The id seeds it until the registry names a seed (or once the registry drops the agent).
  const seed = useAssistants((s) => agentOf(s, id)?.avatar ?? id)
  return (
    <img
      className={className}
      src={portrait(seed)}
      alt=""
      aria-hidden
      draggable={false}
      data-testid={`agent-portrait-${id}`}
    />
  )
}
