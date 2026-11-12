import './agent-work.css'
import type { CSSProperties } from 'react'
import { IconCheck } from '@tabler/icons-react'
import type { TabAgent, TabState } from '@evaos/contract'
import { AgentFace, agentOp, workingLine } from '../../browser/AgentCaption'
import { useBrowserStore } from '../../browser/browser-store'
import { elapsedLabel } from '../../context/format'
import { invoke } from '../../ipc'
import { closeTab } from '../../tiling/tiling-store'
import { focusWebTab, webPanelId } from '../../tiling/web-tabs'
import { useDismissedIds } from '../status-card/dismissed-cards'
import { StatusCard } from '../status-card/StatusCard'
import { useMinute } from './SubagentChips'
/** The card's one line for each state of the agent's run. */
function cardLine(a: TabAgent): string {
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

function WorkCard({ tab, agent, now }: { tab: TabState; agent: TabAgent; now: number }) {
  const s = agent.status
  const line = cardLine(agent)
  const finished = s === 'done' || s === 'stopped'
  return (
    <StatusCard
      id={cardId(tab, agent)}
      testId={`agent-work-${tab.id}`}
      data={{ 'data-status': s }}
      label={`Open ${agent.name}'s tab`}
      style={{ '--eva-agent': agent.color } as CSSProperties}
      lead={<AgentFace agent={agent} size="s" />}
      line={s === 'working' ? <span className="eva-agent-shimmer">{line}</span> : line}
      lineTitle={line}
      onOpen={() => focusWebTab(tab.id)}
      onDismiss={finished ? () => closeFinished(tab) : undefined}
      dismissLabel={finished ? 'Dismiss and close tab' : 'Dismiss'}
      actions={
        s === 'ask' ? (
          <span className="eva-agent-acts">
            <button
              type="button"
              className="eva-agent-btn eva-agent-btn-primary"
              data-testid="agent-work-allow"
              onClick={() => agentOp(tab.id, 'allow')}
            >
              Allow
            </button>
            <button
              type="button"
              className="eva-agent-btn eva-agent-btn-quiet"
              data-testid="agent-work-deny"
              onClick={() => agentOp(tab.id, 'deny')}
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

/** A run's card id: a new run on the same page is a new card, so it shows again. */
const cardId = (tab: TabState, agent: TabAgent): string => `agent-work:${tab.id}@${agent.since}`

/**
 * One row per page an agent drives in the workspace on screen, above the composer: its face, what
 * it is doing, how long, and Allow or Not now while it asks. A click brings its tab forward.
 */
export function AgentWorkCards() {
  const tabs = useBrowserStore((s) => s.tabs)
  const now = useMinute()
  const dismissed = useDismissedIds()
  const live = tabs.filter(
    (t) =>
      t.agent !== undefined && t.agent.status !== 'idle' && !dismissed.includes(cardId(t, t.agent)),
  )
  if (live.length === 0) return null
  return (
    <div className="eva-agent-work" data-testid="agent-work">
      {live.map((t) => (
        <WorkCard key={t.id} tab={t} agent={t.agent!} now={now} />
      ))}
    </div>
  )
}
