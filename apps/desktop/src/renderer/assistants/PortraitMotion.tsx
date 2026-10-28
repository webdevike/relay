import type { CSSProperties, ReactNode } from 'react'
import { STATE_META } from '@relay/portrait-motion'
import { agentOf, useAssistants } from './assistants-store'
import { dotLabel, useAgentMotion } from './motion-store'
import './portrait-motion.css'

/**
 * Agent `id`'s small portrait (`children`, the still face) with its mood, all in CSS: it breathes,
 * the accent ring turns while the agent thinks, researches or works, and the status dot shows
 * accent while it runs, orange when it needs Isaac, red when its turn failed. The face and dot come
 * from the agent's director (motion-store), so this re-renders only when they change. Sized by
 * `className`.
 */
export function PortraitMotion({
  id,
  className,
  testId,
  children,
}: {
  id: string
  className?: string
  testId?: string
  children: ReactNode
}) {
  const view = useAgentMotion(id)
  const accent = useAssistants((s) => agentOf(s, id)?.avatar.colors?.accent)
  return (
    <span
      className={className === undefined ? 'eva-pm' : `eva-pm ${className}`}
      data-state={view.state}
      data-ring={STATE_META[view.state].ring}
      data-dot={view.dot ?? undefined}
      data-testid={testId}
      style={accent === undefined ? undefined : ({ '--eva-pm-accent': accent } as CSSProperties)}
    >
      {children}
      <span className="eva-pm-ring" aria-hidden />
      {view.dot === null ? null : (
        <span className="eva-pm-dot" role="img" aria-label={dotLabel(view)} />
      )}
    </span>
  )
}
