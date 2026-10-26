import './strips.css'
import { Scroller, Tooltip } from '@mantine/core'
import { IconAlertCircle, IconCheck, IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import type { Subagent } from '@evaos/chat-core/message'

export type SubagentState = 'running' | 'done' | 'failed'

export const subagentState = (s: Subagent): SubagentState =>
  s.failed ? 'failed' : s.done ? 'done' : 'running'

/** Spinner while running, a check when done, an alert when failed. */
export function SubagentStateIcon({ state }: { state: SubagentState }) {
  if (state === 'running') return <span className="eva-spinner" aria-hidden="true" />
  if (state === 'failed') return <IconAlertCircle size={12} aria-hidden="true" />
  return <IconCheck size={12} aria-hidden="true" />
}

export interface SubagentChipsProps {
  subagents: readonly Subagent[]
  /** Finished chips the user cleared; they are left out here. */
  hidden: ReadonlySet<string>
  /** The subagent whose transcript the side panel shows, if any. */
  active?: string | null
  onOpen: (s: Subagent) => void
  onClearDone: () => void
}

/**
 * A chip per subagent of the open chat, newest first, in a horizontal scroller. Clear done stays
 * pinned at the row's end. Rendered outside the virtualized log.
 */
export function SubagentChips({
  subagents,
  hidden,
  active = null,
  onOpen,
  onClearDone,
}: SubagentChipsProps) {
  const shown = subagents.filter((s) => !(s.done && hidden.has(s.name)))
  if (shown.length === 0) return null
  const anyDone = shown.some((s) => s.done)
  return (
    <div className="eva-chips" data-testid="subagent-chips" role="group" aria-label="Subagents">
      <Scroller
        className="eva-chips-scroller"
        classNames={{ content: 'eva-chips-content' }}
        edgeGradientColor="var(--eva-c-background)"
        controlSize={28}
        scrollAmount={160}
        startControlIcon={<IconChevronLeft size={14} stroke={1.5} />}
        endControlIcon={<IconChevronRight size={14} stroke={1.5} />}
      >
        {shown.map((s) => {
          const state = subagentState(s)
          return (
            <Tooltip
              key={s.name}
              label={s.lastLine}
              disabled={s.lastLine === ''}
              multiline
              maw={320}
              openDelay={400}
              position="top-start"
            >
              <button
                type="button"
                className="eva-chip eva-label"
                data-testid={`subagent-chip-${s.name}`}
                data-state={state}
                data-active={active === s.name ? 'true' : undefined}
                aria-pressed={active === s.name}
                aria-label={`Subagent ${s.name}, ${state}`}
                onClick={() => onOpen(s)}
              >
                <SubagentStateIcon state={state} />
                <span className="eva-chip-name">{s.name}</span>
              </button>
            </Tooltip>
          )
        })}
      </Scroller>
      <button
        type="button"
        className="eva-chips-clear eva-label"
        data-testid="subagent-clear-done"
        disabled={!anyDone}
        onClick={onClearDone}
      >
        Clear done
      </button>
    </div>
  )
}
