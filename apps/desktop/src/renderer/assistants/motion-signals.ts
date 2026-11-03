import type { ChatMessage } from '@evaos/chat-core/message'
import { toolKind, type MotionSignals, type ToolKind } from '@relay/portrait-motion'
import type { PaneState } from '../chat/chat-store'
import { agentOf, type AssistantsState } from './assistants-store'

/**
 * Where an agent's portrait gets its mood: the `MotionSignals` the portrait-motion `Director`
 * turns into a face (Thinking, Researching, Working, Idle). Relay's
 * status and running tool and the Start button are known for every agent; the open thread's
 * detail (its tool rows, subagents, jobs, question, failure) only for the agent whose thread main's
 * chat pane shows. A reply streaming in is just its turn running.
 */
export function motionSignals(
  assistants: AssistantsState,
  id: string,
  /** Main's chat pane, which counts only while it shows this agent's thread file. */
  pane: PaneState | null | undefined,
): MotionSignals {
  const agent = agentOf(assistants, id)
  const open = pane && agent?.file && pane.file === agent.file ? pane : null
  const status = agent?.status ?? 'not-started'
  return {
    running: status === 'working' || assistants.starting[id] === true || (open?.running ?? false),
    tool: toolOf(agent?.tool ?? null, open),
    waiting: status === 'needs-you' || (open?.dialog ?? null) !== null,
    failed:
      assistants.failed[id] !== undefined ||
      (open !== null && (open.error !== null || turnFailed(open.messages))),
    activityAt: agent?.reply?.at ?? null,
  }
}

/**
 * What the turn's running tools are doing. Running subagents stand in for the tool that spawned
 * them: they research only when every one of them does. Otherwise the tool Relay hears running,
 * else the open pane's newest running tool row in this turn; background jobs work.
 */
export function toolOf(relayTool: string | null, pane: PaneState | null): ToolKind | null {
  const subs = (pane?.extras.subagents ?? []).flatMap((a) =>
    !a.done && a.tool !== null ? [toolKind(a.tool)] : [],
  )
  if (subs.length > 0) return subs.every((k) => k === 'research') ? 'research' : 'work'
  if (relayTool !== null) return toolKind(relayTool)
  const messages = pane?.messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user') break
    if (m.role === 'tool' && m.tool?.status === 'running') return toolKind(m.text)
  }
  return (pane?.extras.jobs.length ?? 0) > 0 ? 'work' : null
}

/** The last turn ended on an `Error:` notice (a failed prompt or command, chat-core's reducer). */
export function turnFailed(messages: readonly ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user') return false
    if (m.role === 'notice' && m.text.startsWith('Error:')) return true
  }
  return false
}
