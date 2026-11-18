import { Avatar, type MantineSize } from '@mantine/core'
import type { AssistantPortrait } from '@evaos/contract'
import type { MotionState } from '@relay/portrait-motion'
import { portrait } from '../ui/portrait'

export interface AssistantAvatarProps {
  /** A notionists seed, or a designed portrait. */
  face: string | AssistantPortrait
  size?: MantineSize | undefined
  /** The agent's mood (motion-store): it breathes slower while snoozing. */
  state?: MotionState | undefined
  className?: string | undefined
  testId?: string | undefined
}

/**
 * An agent's small portrait, breathing gently in CSS (.eva-pm, portrait-motion.css), on light
 * paper in both schemes (assistants.css). Presentational: the sidebar feeds it each agent's mood
 * (AgentAvatar), and the `relay` design system's kit draws the same component.
 */
export function AssistantAvatar({
  face,
  size = 'md',
  state,
  className,
  testId,
}: AssistantAvatarProps) {
  return (
    <span
      className={className === undefined ? 'eva-pm' : `eva-pm ${className}`}
      data-state={state}
      data-testid={testId}
    >
      <Avatar
        className="eva-as-avatar"
        size={size}
        radius="xl"
        src={portrait(face)}
        alt=""
        aria-hidden
      />
    </span>
  )
}
