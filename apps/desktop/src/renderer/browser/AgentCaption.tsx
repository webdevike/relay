import { IconCheck, IconHandStop, IconPlayerPlay, IconX } from '@tabler/icons-react'
import type { AgentRunOp, AgentRun } from '@evaos/contract'
import { agentFace } from '../agent/identity'
import { invoke } from '../ipc'
import { useAssistants } from '../assistants/assistants-store'
import './browser.css'

/** Isaac's control on an agent's tab (Take over, Hand back, Allow, Not now, dismiss). */
export function agentOp(tabId: string, op: AgentRunOp): void {
  void invoke('browser.agent', { tabId, op })
}

/** An agent's face: its portrait in a rounded square. */
export function AgentFace({
  agent,
  size,
}: {
  agent: Pick<AgentRun, 'id' | 'name'>
  size: 's' | 'xs'
}) {
  // Portraits arrive with the assistants list; re-render when it does.
  useAssistants((s) => s.data)
  return (
    <img
      className={`eva-agent-face eva-agent-face-${size}`}
      src={agentFace(agent.id)}
      alt={agent.name}
      draggable={false}
    />
  )
}

/** What the caption row says while the agent works, when it gave no caption itself. */
export const workingLine = (a: AgentRun): string => a.caption || `${a.name} is working`

/**
 * The one row under a page an agent drives: who, what it is doing, and Isaac's control for that
 * moment. Working: its caption, Take over on hover. Paused: Hand back. Ask: Allow or Not now.
 * Done or stopped: how it ended, dismissable. The native page paints over anything the shell
 * draws on it, so the row sits below the page, inside the agent's ring.
 */
export function AgentCaption({ tabId, agent }: { tabId: string; agent: AgentRun }) {
  const s = agent.status
  const line =
    s === 'working'
      ? workingLine(agent)
      : s === 'paused'
        ? `You're driving. ${agent.name} paused`
        : s === 'ask'
          ? `${agent.name} wants to ${agent.ask?.label ?? 'go on'}`
          : agent.caption
  return (
    <div
      className="eva-agent-caption"
      data-status={s}
      data-testid="agent-caption"
      role={s === 'ask' ? 'alert' : 'status'}
    >
      {s === 'done' ? (
        <IconCheck className="eva-agent-ok" size={16} stroke={2} aria-hidden />
      ) : (
        <AgentFace agent={agent} size="s" />
      )}
      <span className="eva-agent-caption-text" title={line}>
        {s === 'working' ? (
          <span className="eva-agent-shimmer">{workingLine(agent)}</span>
        ) : s === 'paused' ? (
          <>
            <b>You're driving.</b> <span className="eva-dim">{agent.name} paused</span>
          </>
        ) : s === 'ask' ? (
          <b>
            {agent.name} wants to {agent.ask?.label ?? 'go on'}
          </b>
        ) : (
          agent.caption
        )}
      </span>
      <span className={s === 'working' ? 'eva-agent-acts eva-agent-acts-hover' : 'eva-agent-acts'}>
        {s === 'working' ? (
          <button
            type="button"
            className="eva-agent-btn"
            title={`Pause ${agent.name} and use this tab yourself`}
            data-testid="agent-take-over"
            onClick={() => agentOp(tabId, 'takeOver')}
          >
            <IconHandStop size={14} stroke={1.75} aria-hidden />
            Take over
          </button>
        ) : s === 'paused' ? (
          <button
            type="button"
            className="eva-agent-btn eva-agent-btn-primary"
            title={`Let ${agent.name} go on from here`}
            data-testid="agent-hand-back"
            onClick={() => agentOp(tabId, 'handBack')}
          >
            <IconPlayerPlay size={14} stroke={1.75} aria-hidden />
            Hand back
          </button>
        ) : s === 'ask' ? (
          <>
            <button
              type="button"
              className="eva-agent-btn eva-agent-btn-primary"
              data-testid="agent-allow"
              onClick={() => agentOp(tabId, 'allow')}
            >
              Allow
            </button>
            <button
              type="button"
              className="eva-agent-btn eva-agent-btn-quiet"
              data-testid="agent-deny"
              onClick={() => agentOp(tabId, 'deny')}
            >
              Not now
            </button>
          </>
        ) : (
          <button
            type="button"
            className="eva-agent-btn eva-agent-btn-quiet eva-agent-btn-icon"
            title="Dismiss"
            aria-label="Dismiss"
            data-testid="agent-dismiss"
            onClick={() => agentOp(tabId, 'dismiss')}
          >
            <IconX size={14} stroke={1.75} aria-hidden />
          </button>
        )}
      </span>
    </div>
  )
}
