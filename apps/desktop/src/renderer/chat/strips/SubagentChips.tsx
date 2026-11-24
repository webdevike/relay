import './strips.css'
import { useEffect, useMemo, useState } from 'react'
import { Tooltip } from '@mantine/core'
import { IconHandStop } from '@tabler/icons-react'
import type { ActivityItem } from '@evaos/chat-core/activity'
import { etaView, type EtaView } from '@relay/protocol'
import { subagentFinished } from '@evaos/chat-core/jobs'
import type { Subagent } from '@evaos/chat-core/message'
import { elapsedLabel } from '../../context/format'
import { KIND_ICON } from '../../artifacts/ActivityRows'
import {
  etaItem,
  hasEta,
  helperActivityId,
  subagentTranscriptFile,
  useEtaNow,
} from '../../activity/eta'
import { ChipStrip, SessionChip, type SubagentState } from './Chip'

const NONE: readonly ActivityItem[] = []

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

/** The estimate's two tooltip lines: what is left, then how sure and why. */
function EtaTip({ view, id }: { view: EtaView; id: string }) {
  return (
    <div data-testid={`eta-tip-${id}`}>
      <div>{view.label}</div>
      <div className="eva-dim">{view.detail}</div>
    </div>
  )
}

/** "12m" muted after the name; nothing for a run that is taking longer, or one that just ended. */
function EtaShort({ view }: { view: EtaView | null }) {
  if (view === null || view.short === null) return null
  return (
    <span className="eva-chip-eta" data-testid="eta-short">
      {view.short}
    </span>
  )
}

export interface SubagentChipsProps {
  subagents: readonly Subagent[]
  /** Finished chips the user cleared; they are left out here. */
  hidden: ReadonlySet<string>
  /** The subagent whose transcript the side panel shows, if any. */
  active?: string | null
  /** `split`: Cmd (or Ctrl) was held, so open it beside the pane instead of in place. */
  onOpen: (s: Subagent, split: boolean) => void
  onClearDone: () => void
  /**
   * Everything else this chat's assistant has in progress (sessions, harnesses, canvas agents, and
   * helpers the transcripts do not list): a badge each, opened the way the Working tab's rows are.
   */
  activity?: readonly ActivityItem[]
  onOpenActivity?: (item: ActivityItem, split: boolean) => void
  /**
   * The host's whole activity list: a helper chip finds its run (`helper:<transcript path>`) here
   * for its estimate. Keep its identity between renders.
   */
  helperActivity?: readonly ActivityItem[]
  /** The chat's session file, which names where its subagents' transcripts live. */
  sessionFile?: string
}

/**
 * A chip per subagent of the open chat and per piece of work its assistant has in progress, newest
 * first, in a horizontal scroller. Clear done stays pinned at the row's end. Rendered outside the
 * virtualized log.
 */
export function SubagentChips({
  subagents,
  hidden,
  active = null,
  onOpen,
  onClearDone,
  activity = NONE,
  onOpenActivity,
  helperActivity = NONE,
  sessionFile = '',
}: SubagentChipsProps) {
  const now = useMinute()
  const withEta = useMemo(
    () => [...activity, ...helperActivity.filter((i) => i.kind === 'helper')].filter(hasEta),
    [activity, helperActivity],
  )
  const etaNow = useEtaNow(withEta.length > 0)
  const shown = subagents.filter((s) => !(subagentFinished(s, now) && hidden.has(s.name)))
  if (shown.length === 0 && activity.length === 0) return null
  const anyDone = shown.some((s) => subagentFinished(s, now))
  return (
    <ChipStrip
      data-testid="subagent-chips"
      role="group"
      aria-label="Subagents"
      end={
        <button
          type="button"
          className="eva-chips-clear eva-label"
          data-testid="subagent-clear-done"
          disabled={!anyDone}
          onClick={onClearDone}
        >
          Clear done
        </button>
      }
    >
      {shown.map((s) => {
        const state = subagentState(s, now)
        // The helper's run in the host's list, when it has an estimate.
        const id = helperActivityId(subagentTranscriptFile(sessionFile, s.file))
        const run = state === 'running' ? etaItem(withEta, id) : undefined
        const view = run?.eta === undefined ? null : etaView(run.eta, etaNow)
        return (
          <Tooltip
            key={s.name}
            label={
              <div>
                {s.lastLine === '' ? null : <div>{s.lastLine}</div>}
                {view === null ? null : <EtaTip view={view} id={id} />}
              </div>
            }
            disabled={s.lastLine === '' && view === null}
            multiline
            maw={320}
            openDelay={400}
            position="top-start"
          >
            <SessionChip
              label={s.name}
              state={state}
              data-testid={`subagent-chip-${s.name}`}
              data-active={active === s.name ? 'true' : undefined}
              aria-pressed={active === s.name}
              aria-label={`Subagent ${s.name}, ${state}`}
              onClick={(e) => onOpen(s, e.metaKey || e.ctrlKey)}
            >
              <EtaShort view={view} />
            </SessionChip>
          </Tooltip>
        )
      })}
      {activity.map((item) => {
        const Kind = KIND_ICON[item.kind]
        const waiting = item.status === 'waiting'
        const age = elapsedLabel(item.startedAt, now)
        const view = item.eta === undefined || !hasEta(item) ? null : etaView(item.eta, etaNow)
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
                {view === null ? null : <EtaTip view={view} id={item.id} />}
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
              onClick={(e) => onOpenActivity?.(item, e.metaKey || e.ctrlKey)}
            >
              {waiting ? (
                <IconHandStop size={12} aria-hidden="true" />
              ) : (
                <span className="eva-spinner" aria-hidden="true" />
              )}
              <Kind size={12} stroke={1.5} aria-hidden="true" />
              <span className="eva-chip-name">{item.title}</span>
              <EtaShort view={view} />
            </button>
          </Tooltip>
        )
      })}
    </ChipStrip>
  )
}
