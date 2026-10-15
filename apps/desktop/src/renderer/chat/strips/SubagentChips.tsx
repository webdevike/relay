import './strips.css'
import { useState } from 'react'
import { IconAlertCircle, IconCheck } from '@tabler/icons-react'
import type { Subagent } from '@evaos/chat-core/message'
import { EvaPopover } from '../../overlay'

export interface SubagentChipsProps {
  subagents: readonly Subagent[]
  /** Finished chips the user cleared; they are left out here. */
  hidden: ReadonlySet<string>
  onClearDone: () => void
}

/** A chip per subagent of the open chat, newest first. Rendered outside the virtualized log. */
export function SubagentChips({ subagents, hidden, onClearDone }: SubagentChipsProps) {
  const [open, setOpen] = useState<string | null>(null)
  const shown = subagents.filter((s) => !(s.done && hidden.has(s.name)))
  if (shown.length === 0) return null
  const anyDone = shown.some((s) => s.done)
  return (
    <div className="eva-chips" data-testid="subagent-chips" role="group" aria-label="Subagents">
      {shown.map((s) => {
        const state = s.failed ? 'failed' : s.done ? 'done' : 'running'
        return (
          <EvaPopover
            key={s.name}
            opened={open === s.name}
            onChange={(o) => setOpen(o ? s.name : null)}
            position="top-start"
          >
            <EvaPopover.Target>
              <button
                type="button"
                className="eva-chip eva-label"
                data-testid={`subagent-chip-${s.name}`}
                data-state={state}
                aria-label={`Subagent ${s.name}, ${state}`}
                onClick={() => setOpen(open === s.name ? null : s.name)}
              >
                {state === 'running' ? (
                  <span className="eva-spinner" aria-hidden="true" />
                ) : state === 'failed' ? (
                  <IconAlertCircle size={12} aria-hidden="true" />
                ) : (
                  <IconCheck size={12} aria-hidden="true" />
                )}
                <span className="eva-chip-name">{s.name}</span>
              </button>
            </EvaPopover.Target>
            <EvaPopover.Dropdown>
              <div className="eva-chip-popover" data-testid="subagent-popover">
                <div className="eva-label">{s.name}</div>
                <div className="eva-dim">{s.lastLine === '' ? 'No status yet.' : s.lastLine}</div>
              </div>
            </EvaPopover.Dropdown>
          </EvaPopover>
        )
      })}
      {anyDone ? (
        <button type="button" className="eva-chips-clear eva-label" onClick={onClearDone}>
          Clear done
        </button>
      ) : null}
    </div>
  )
}
