import type { ChatMessage } from '@evaos/chat-core/message'
import { isNothingToReport } from '@evaos/chat-core/quiet'
import type { MotionSignals } from '@relay/portrait-motion'
import type { PaneState } from '../chat/chat-store'
import { agentOf, type AssistantsState } from './assistants-store'

/**
 * Where an agent's portrait gets its mood: the `MotionSignals` the portrait-motion `Director`
 * turns into a state. Relay's status and the Start button are known for every agent; the open
 * thread's detail (its stream, tools, subagents, jobs, question, failure) only for the agent whose
 * thread main's chat pane shows. No call reaches the desktop, so `listening` is always false.
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
    working: open !== null && paneWorking(open),
    talking: open !== null && talking(open.messages),
    listening: false,
    waiting: status === 'needs-you' || (open?.dialog ?? null) !== null,
    failed:
      assistants.failed[id] !== undefined ||
      (open !== null && (open.error !== null || turnFailed(open.messages))),
    activityAt: agent?.reply?.at ?? null,
  }
}

/** Tools, subagents or background jobs run inside the pane's thread. */
export function paneWorking(pane: PaneState): boolean {
  if (pane.extras.jobs.length > 0) return true
  if (pane.extras.subagents.some((a) => !a.done)) return true
  for (let i = pane.messages.length - 1; i >= 0; i--) {
    const m = pane.messages[i]!
    if (m.role === 'user') return false
    if (m.role === 'tool' && m.tool?.status === 'running') return true
  }
  return false
}

/**
 * The reply streams in: ChatLog's rule (the last row it shows is an assistant reply streaming
 * text), read from the end. ChatLog hides quiet turns (every reply `(nothing to report)`), so a
 * quiet last turn does not talk.
 */
export function talking(messages: readonly ChatMessage[]): boolean {
  const last = messages.at(-1)
  if (last?.role !== 'assistant' || !last.streaming || last.text === '') return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user') break
    if (m.role === 'assistant' && !isNothingToReport(m.text)) return true
  }
  return false
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

/** Signals are equal (the motion store re-ticks a director only when they move). */
export function sameSignals(a: MotionSignals, b: MotionSignals): boolean {
  return (
    a.running === b.running &&
    a.working === b.working &&
    a.talking === b.talking &&
    a.listening === b.listening &&
    a.waiting === b.waiting &&
    a.failed === b.failed &&
    a.activityAt === b.activityAt
  )
}
