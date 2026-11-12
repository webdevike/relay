import './agent-work.css'
import type { CSSProperties } from 'react'
import { IconCheck } from '@tabler/icons-react'
import type { AgentRun, AgentRunOp, TabState } from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import { AgentFace, agentOp, workingLine } from '../../browser/AgentCaption'
import { useBrowserStore } from '../../browser/browser-store'
import { canvasAgentOp, useCanvasRuns } from '../../canvas/agent/runs-store'
import { elapsedLabel } from '../../context/format'
import { invoke } from '../../ipc'
import { closeTab, openPlaceBeside, useTiling } from '../../tiling/tiling-store'
import { focusWebTab, webPanelId } from '../../tiling/web-tabs'
import { useDismissedIds } from '../status-card/dismissed-cards'
import { StatusCard } from '../status-card/StatusCard'
import { useMinute } from './SubagentChips'

/** The card's one line for each state of the agent's run. */
function cardLine(a: AgentRun): string {
  switch (a.status) {
    case 'ask':
      return `Wants to ${a.ask?.label ?? 'go on'}`
    case 'paused':
      return "Paused, you're driving"
    case 'working':
      return workingLine(a)
    default:
      return a.caption || (a.status === 'done' ? 'Done' : 'Stopped')
  }
}

/**
 * The page's tab goes with a finished run's card; the caption's own dismiss clears the run first.
 * A tab no pane holds closes through the browser directly.
 */
function closeFinished(tab: TabState): void {
  agentOp(tab.id, 'dismiss')
  try {
    closeTab(webPanelId(tab.id))
  } catch {
    void invoke('browser.closeTab', { tabId: tab.id })
  }
}

/** One surface an agent works: its run, what the card names it by, and how it opens. */
interface Work {
  agent: AgentRun
  /** The card's id: a new run on the same surface is a new card, so it shows again. */
  id: string
  testid: string
  /** What the card opens, for its tooltip (`Penny's tab`, `the Plan board`). */
  what: string
  /** The surface's own name before the line (a board's title); a page needs none. */
  label?: string
  open: () => void
  op: (op: AgentRunOp) => void
  /** What dismissing a finished run's card does besides hiding it, and what the X says. */
  finish: () => void
  finishLabel: string
}

function WorkCard({ work, now }: { work: Work; now: number }) {
  const { agent, label } = work
  const s = agent.status
  const line = cardLine(agent)
  const finished = s === 'done' || s === 'stopped'
  return (
    <StatusCard
      id={work.id}
      testId={work.testid}
      data={{ 'data-status': s }}
      label={`Open ${work.what}`}
      style={{ '--eva-agent': agent.color } as CSSProperties}
      lead={<AgentFace agent={agent} size="s" />}
      line={
        <>
          {label ? <b className="eva-agent-work-what">{label}</b> : null}
          {s === 'working' ? <span className="eva-agent-shimmer">{line}</span> : line}
        </>
      }
      lineTitle={label ? `${label}: ${line}` : line}
      onOpen={work.open}
      onDismiss={finished ? work.finish : undefined}
      dismissLabel={finished ? work.finishLabel : 'Dismiss'}
      actions={
        s === 'ask' ? (
          <span className="eva-agent-acts">
            <button
              type="button"
              className="eva-agent-btn eva-agent-btn-primary"
              data-testid="agent-work-allow"
              onClick={() => work.op('allow')}
            >
              Allow
            </button>
            <button
              type="button"
              className="eva-agent-btn eva-agent-btn-quiet"
              data-testid="agent-work-deny"
              onClick={() => work.op('deny')}
            >
              Not now
            </button>
          </span>
        ) : undefined
      }
      meta={
        s === 'ask' ? undefined : (
          <>
            {s === 'done' ? <IconCheck size={14} stroke={2} aria-hidden /> : null}
            {elapsedLabel(agent.since, agent.ended ?? now)}
          </>
        )
      }
    />
  )
}

/**
 * One row per surface an agent works in the workspace on screen, above the composer: the pages it
 * drives and the boards it works. Its face, what it is doing, how long, and Allow or Not now while
 * it asks. A click brings its tab forward, or opens its board beside the chat.
 */
export function AgentWorkCards() {
  const tabs = useBrowserStore((s) => s.tabs)
  const runs = useCanvasRuns((s) => s.runs)
  const front = useTiling((s) => s.scope)
  const now = useMinute()
  const dismissed = useDismissedIds()
  const work: Work[] = [
    ...tabs.flatMap((t): Work[] =>
      t.agent === undefined || t.agent.status === 'idle'
        ? []
        : [
            {
              agent: t.agent,
              id: `agent-work:${t.id}@${t.agent.since}`,
              testid: `agent-work-${t.id}`,
              what: `${t.agent.name}'s tab`,
              open: () => void focusWebTab(t.id),
              op: (op) => agentOp(t.id, op),
              finish: () => closeFinished(t),
              finishLabel: 'Dismiss and close tab',
            },
          ],
    ),
    ...runs
      .filter((r) => r.status !== 'idle' && r.workspace !== null && r.workspace === front)
      .map((r): Work => ({
        agent: r,
        id: `agent-work:canvas:${r.slug}@${r.since}`,
        testid: `agent-work-canvas-${r.slug}`,
        what: `the ${r.board} board`,
        label: r.board,
        open: () => openPlaceBeside(placeOf('canvas', { canvas: r.slug })),
        op: (op) => void canvasAgentOp(r.slug, op),
        finish: () => void canvasAgentOp(r.slug, 'dismiss'),
        finishLabel: 'Dismiss',
      })),
  ].filter((w) => !dismissed.includes(w.id))
  if (work.length === 0) return null
  return (
    <div className="eva-agent-work" data-testid="agent-work">
      {work.map((w) => (
        <WorkCard key={w.testid} work={w} now={now} />
      ))}
    </div>
  )
}
