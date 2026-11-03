import type { ReactNode } from 'react'
import { useAgentMotion } from './motion-store'
import './portrait-motion.css'

/**
 * Agent `id`'s small portrait (`children`, the still face), breathing gently in CSS, slower while
 * it snoozes. Its face state comes from the agent's director (motion-store) as `data-state`, so
 * this re-renders only when that changes. Sized by `className`.
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
  return (
    <span
      className={className === undefined ? 'eva-pm' : `eva-pm ${className}`}
      data-state={state}
      data-testid={testId}
    >
      {children}
    </span>
  )
}
