import type { CSSProperties, ReactNode } from 'react'
import { STATE_META } from '@relay/portrait-motion'
import { agentOf, useAssistants } from './assistants-store'
import { useAgentMotion } from './motion-store'
import './portrait-motion.css'

/**
 * Agent `id`'s small portrait (`children`, the still face) with its mood, all in CSS: it breathes,
 * the accent ring turns while the agent thinks or works, and a dot shows the state's tone (accent,
 * orange when it needs Isaac, red when its turn failed). The state comes from the agent's director
 * (motion-store), so this re-renders only on a state change. Sized by `className`.
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
  const state = useAgentMotion(id)
  const accent = useAssistants((s) => agentOf(s, id)?.avatar.colors?.accent)
  const meta = STATE_META[state]
  return (
    <span
      className={className === undefined ? 'eva-pm' : `eva-pm ${className}`}
      data-state={state}
      data-ring={meta.ring}
      data-dot={meta.dot ?? undefined}
      data-testid={testId}
      style={accent === undefined ? undefined : ({ '--eva-pm-accent': accent } as CSSProperties)}
    >
      {children}
      <span className="eva-pm-ring" aria-hidden />
      {meta.dot === null ? null : (
        <span className="eva-pm-dot" role="img" aria-label={meta.status} />
      )}
    </span>
  )
}
