import './strips.css'
import { useEffect, useState } from 'react'
import { Scroller, Tooltip } from '@mantine/core'
import {
  IconAlertCircle,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconHandStop,
} from '@tabler/icons-react'
import type { ActivityItem } from '@evaos/chat-core/activity'
import { subagentFinished } from '@evaos/chat-core/jobs'
import type { Subagent } from '@evaos/chat-core/message'
import { elapsedLabel } from '../../context/format'
import { KIND_ICON } from '../../artifacts/ActivityRows'

export type SubagentState = 'running' | 'done' | 'failed'

/** A clock that ticks each minute, so a subagent that goes quiet stops spinning without new files. */
export function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

export const subagentState = (s: Subagent, now: number): SubagentState =>
  s.failed ? 'failed' : subagentFinished(s, now) ? 'done' : 'running'

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
  /**
   * Everything else this chat's assistant has in progress (sessions, harnesses, canvas agents, and
   * helpers the transcripts do not list): a badge each, opened the way the Working tab's rows are.
   */
  activity?: readonly ActivityItem[]
  onOpenActivity?: (item: ActivityItem) => void
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
  activity = [],
  onOpenActivity,
}: SubagentChipsProps) {
  const now = useMinute()
  const shown = subagents.filter((s) => !(subagentFinished(s, now) && hidden.has(s.name)))
  if (shown.length === 0 && activity.length === 0) return null
  const anyDone = shown.some((s) => subagentFinished(s, now))
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
          const state = subagentState(s, now)
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
                <KIND_ICON.helper size={12} stroke={1.5} aria-hidden="true" />
                <span className="eva-chip-name">{s.name}</span>
              </button>
            </Tooltip>
          )
        })}
        {activity.map((item) => {
          const Kind = KIND_ICON[item.kind]
          const waiting = item.status === 'waiting'
          const age = elapsedLabel(item.startedAt, now)
          return (
            <Tooltip
              key={item.id}
              label={
                <div data-testid={`activity-chip-tip-${item.id}`}>
                  <div>{item.title}</div>
                  <div className="eva-dim">
                    {item.model === undefined ? '' : `${item.model} · `}
                    {age === 'now' ? 'just started' : `running ${age}`}
                  </div>
                  {item.intent === '' ? null : <div>{item.intent}</div>}
                </div>
              }
              multiline
              maw={320}
              openDelay={400}
              position="top-start"
            >
              <button
                type="button"
                className="eva-chip eva-label"
                data-testid={`activity-chip-${item.id}`}
                data-state={waiting ? 'waiting' : 'running'}
                data-kind={item.kind}
                aria-label={`${item.kind} ${item.title}, ${waiting ? 'waiting on you' : 'running'}`}
                onClick={() => onOpenActivity?.(item)}
              >
                {waiting ? (
                  <IconHandStop size={12} aria-hidden="true" />
                ) : (
                  <span className="eva-spinner" aria-hidden="true" />
                )}
                <Kind size={12} stroke={1.5} aria-hidden="true" />
                <span className="eva-chip-name">{item.title}</span>
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
