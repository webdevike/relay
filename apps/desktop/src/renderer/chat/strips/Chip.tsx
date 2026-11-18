import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Scroller } from '@mantine/core'
import {
  IconAlertCircle,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconSubtask,
} from '@tabler/icons-react'

/*
 * The composer's run chips, presentational only (strips.css styles them): SubagentChips wires them
 * to runs and transcripts, and the `relay` design system's kit draws the same components.
 */

export type SubagentState = 'running' | 'done' | 'failed'

/** Spinner while running, a check when done, an alert when failed. */
export function SubagentStateIcon({ state }: { state: SubagentState }) {
  if (state === 'running') return <span className="eva-spinner" aria-hidden="true" />
  if (state === 'failed') return <IconAlertCircle size={12} aria-hidden="true" />
  return <IconCheck size={12} aria-hidden="true" />
}

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** The run's name. */
  label: ReactNode
  state: SubagentState
  /** After the name, muted (the session's time left). */
  children?: ReactNode
  ref?: Ref<HTMLButtonElement> | undefined
  'data-testid'?: string | undefined
}

/** One subagent session of the chat: a round chip with its state and the helper icon. */
export function SessionChip({ label, state, className, children, ...rest }: ChipProps) {
  return (
    <button
      type="button"
      {...rest}
      className={className ? `eva-chip eva-label ${className}` : 'eva-chip eva-label'}
      data-state={state}
    >
      <SubagentStateIcon state={state} />
      <IconSubtask size={12} stroke={1.5} aria-hidden="true" />
      <span className="eva-chip-name">{label}</span>
      {children}
    </button>
  )
}

/**
 * The row of chips above the composer: they scroll sideways under edge fades; `end` (Clear done)
 * stays pinned after them, never scrolled away.
 */
export function ChipStrip({
  children,
  end,
  'data-testid': testid,
  'aria-label': label,
  role,
}: {
  children: ReactNode
  end?: ReactNode
  'data-testid'?: string | undefined
  'aria-label'?: string | undefined
  role?: string | undefined
}) {
  return (
    <div className="eva-chips" data-testid={testid} role={role} aria-label={label}>
      <Scroller
        className="eva-chips-scroller"
        classNames={{ content: 'eva-chips-content' }}
        edgeGradientColor="var(--eva-c-background)"
        controlSize={28}
        scrollAmount={160}
        startControlIcon={<IconChevronLeft size={14} stroke={1.5} />}
        endControlIcon={<IconChevronRight size={14} stroke={1.5} />}
      >
        {children}
      </Scroller>
      {end}
    </div>
  )
}
