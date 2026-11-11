import './agent-work.css'
import type { CSSProperties, KeyboardEvent } from 'react'
import { IconArrowUpRight, IconCheck } from '@tabler/icons-react'
import type { TabAgent, TabState } from '@evaos/contract'
import { AgentFace, agentOp, workingLine } from '../../browser/AgentCaption'
import { useBrowserStore } from '../../browser/browser-store'
import { elapsedLabel } from '../../context/format'
import { focusWebTab } from '../../tiling/web-tabs'
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

function WorkCard({ tab, agent, now }: { tab: TabState; agent: TabAgent; now: number }) {
  const s = agent.status
  const open = (): void => {
    focusWebTab(tab.id)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    open()
  }
  const line = cardLine(agent)
  return (
    <div
      className="eva-agent-work-card"
      data-status={s}
      data-testid={`agent-work-${tab.id}`}
      role="button"
      tabIndex={0}
      title={`Open ${agent.name}'s tab`}
      style={{ '--eva-agent': agent.color } as CSSProperties}
      onClick={open}
      onKeyDown={onKey}
    >
      <AgentFace agent={agent} size="s" />
      <span className="eva-agent-work-line" title={line}>
        {s === 'working' ? <span className="eva-agent-shimmer">{line}</span> : line}
      </span>
      {s === 'ask' ? (
        <span className="eva-agent-acts">
          <button
            type="button"
            className="eva-agent-btn eva-agent-btn-primary"
            data-testid="agent-work-allow"
            onClick={(e) => {
              e.stopPropagation()
              agentOp(tab.id, 'allow')
            }}
          >
            Allow
          </button>
          <button
            type="button"
            className="eva-agent-btn eva-agent-btn-quiet"
            data-testid="agent-work-deny"
            onClick={(e) => {
              e.stopPropagation()
              agentOp(tab.id, 'deny')
            }}
          >
            Not now
          </button>
        </span>
      ) : (
        <span className="eva-agent-work-meta">
          {s === 'done' ? <IconCheck size={14} stroke={2} aria-hidden /> : null}
          {elapsedLabel(agent.since, agent.ended ?? now)}
        </span>
      )}
      <IconArrowUpRight className="eva-agent-work-go" size={14} stroke={1.75} aria-hidden />
    </div>
  )
}

/**
 * One row per page an agent drives in the workspace on screen, above the composer: its face, what
 * it is doing, how long, and Allow or Not now while it asks. A click brings its tab forward.
 */
export function AgentWorkCards() {
  const tabs = useBrowserStore((s) => s.tabs)
  const now = useMinute()
  const live = tabs.filter((t) => t.agent !== undefined && t.agent.status !== 'idle')
  if (live.length === 0) return null
  return (
    <div className="eva-agent-work" data-testid="agent-work">
      {live.map((t) => (
        <WorkCard key={t.id} tab={t} agent={t.agent!} now={now} />
      ))}
    </div>
  )
}
