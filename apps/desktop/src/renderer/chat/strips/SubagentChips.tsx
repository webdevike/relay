import './strips.css'
import { useEffect, useMemo, useState } from 'react'
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
import {
  etaFill,
  etaItem,
  etaProps,
  hasEta,
  helperActivityId,
  subagentTranscriptFile,
  useEtaLinger,
  useEtaNow,
  type EtaFill,
} from '../../activity/eta'

const NONE: readonly ActivityItem[] = []

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

/** The estimate's two tooltip lines: what is left, then how sure and why. */
function EtaTip({ fill, id }: { fill: EtaFill; id: string }) {
  return (
    <div data-testid={`eta-tip-${id}`}>
      <div>{fill.view.label}</div>
      <div className="eva-dim">{fill.view.detail}</div>
    </div>
  )
}

/** "12m" muted after the name; nothing for a run that is taking longer, or one that just ended. */
function EtaShort({ fill }: { fill: EtaFill | null }) {
  if (fill === null || fill.leaving !== null || fill.view.short === null) return null
  return (
    <span className="eva-chip-eta" data-testid="eta-short">
      {fill.view.short}
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
   * for its estimate, so it fills like the other badges. Keep its identity between renders.
   */
  helperActivity?: readonly ActivityItem[]
  /** The chat's session file, which names where its subagents' transcripts live. */
  sessionFile?: string
  /** The owning assistant's color for the fill; the accent when there is none. */
  agentColor?: string
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
  activity = NONE,
  onOpenActivity,
  helperActivity = NONE,
  sessionFile = '',
  agentColor,
}: SubagentChipsProps) {
  const now = useMinute()
  const withEta = useMemo(
    () => [...activity, ...helperActivity.filter((i) => i.kind === 'helper')].filter(hasEta),
    [activity, helperActivity],
  )
  const leaving = useEtaLinger(withEta)
  const etaNow = useEtaNow(withEta.length > 0 || leaving.length > 0)
  const shown = subagents.filter((s) => !(subagentFinished(s, now) && hidden.has(s.name)))
  const chips = [...activity, ...leaving.filter((i) => i.kind !== 'helper')]
  if (shown.length === 0 && chips.length === 0) return null
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
          // The helper's run in the host's list: its estimate, or just-finished and filling up.
          const id = helperActivityId(subagentTranscriptFile(sessionFile, s.file))
          const live = state === 'running' ? etaItem(withEta, id) : undefined
          const gone = live === undefined ? leaving.find((i) => i.id === id) : undefined
          const run = live ?? gone
          const fill =
            run?.eta === undefined
              ? null
              : etaFill(run.eta, etaNow, live === undefined ? 'fill' : null)
          return (
            <Tooltip
              key={s.name}
              label={
                <div>
                  {s.lastLine === '' ? null : <div>{s.lastLine}</div>}
                  {fill === null || fill.leaving !== null ? null : <EtaTip fill={fill} id={id} />}
                </div>
              }
              disabled={s.lastLine === '' && (fill === null || fill.leaving !== null)}
              multiline
              maw={320}
              openDelay={400}
              position="top-start"
            >
              <button
                type="button"
                className={fill === null ? 'eva-chip eva-label' : 'eva-chip eva-label eva-eta'}
                data-testid={`subagent-chip-${s.name}`}
                data-state={state}
                data-active={active === s.name ? 'true' : undefined}
                aria-pressed={active === s.name}
                aria-label={`Subagent ${s.name}, ${state}`}
                onClick={(e) => onOpen(s, e.metaKey || e.ctrlKey)}
                {...(fill === null ? {} : etaProps(fill, agentColor))}
              >
                <SubagentStateIcon state={state} />
                <KIND_ICON.helper size={12} stroke={1.5} aria-hidden="true" />
                <span className="eva-chip-name">{s.name}</span>
                <EtaShort fill={fill} />
              </button>
            </Tooltip>
          )
        })}
        {chips.map((item) => {
          const Kind = KIND_ICON[item.kind]
          const waiting = item.status === 'waiting'
          const age = elapsedLabel(item.startedAt, now)
          const leavingNow = !activity.some((a) => a.id === item.id)
          const fill =
            item.eta === undefined || !(hasEta(item) || leavingNow)
              ? null
              : etaFill(item.eta, etaNow, leavingNow ? 'chip' : null)
          return (
            <Tooltip
              key={item.id}
              disabled={leavingNow}
              label={
                <div data-testid={`activity-chip-tip-${item.id}`}>
                  <div>{item.title}</div>
                  <div className="eva-dim">
                    {item.model === undefined ? '' : `${item.model} · `}
                    {age === 'now' ? 'just started' : `running ${age}`}
                  </div>
                  {item.intent === '' ? null : <div>{item.intent}</div>}
                  {fill === null ? null : <EtaTip fill={fill} id={item.id} />}
                </div>
              }
              multiline
              maw={320}
              openDelay={400}
              position="top-start"
            >
              <button
                type="button"
                className={fill === null ? 'eva-chip eva-label' : 'eva-chip eva-label eva-eta'}
                data-testid={`activity-chip-${item.id}`}
                data-state={waiting ? 'waiting' : 'running'}
                data-kind={item.kind}
                aria-label={`${item.kind} ${item.title}, ${waiting ? 'waiting on you' : 'running'}`}
                onClick={(e) => onOpenActivity?.(item, e.metaKey || e.ctrlKey)}
                {...(fill === null ? {} : etaProps(fill, agentColor))}
              >
                {waiting ? (
                  <IconHandStop size={12} aria-hidden="true" />
                ) : (
                  <span className="eva-spinner" aria-hidden="true" />
                )}
                <Kind size={12} stroke={1.5} aria-hidden="true" />
                <span className="eva-chip-name">{item.title}</span>
                <EtaShort fill={fill} />
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
