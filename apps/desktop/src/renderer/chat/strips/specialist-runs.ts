import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { SpecialistRun } from '@evaos/contract'
import type { ChatMessage } from '@evaos/chat-core/message'
import { agentRunKey, liveAgentRuns, recentAgentRuns, type AgentRun } from '@relay/protocol'
import { invoke, on } from '../../ipc'

// A chat's specialist badges: the agents calls its transcript shows, joined with what the
// atomic-agents service recorded for this chat as caller (`agents.specialists`, re-read on every
// journal change while any chat strip is mounted), so a run shows from its ask to its end.

const store = createStore<{ runs: readonly SpecialistRun[] }>(() => ({ runs: [] }))

let watchers = 0
let stop: (() => void) | null = null
let asking = false
let again = false

async function refresh(): Promise<void> {
  if (asking) {
    again = true
    return
  }
  asking = true
  try {
    const r = await invoke('agents.specialists', {})
    if (r.ok && r.value.available && r.value.error === null) store.setState({ runs: r.value.runs })
  } finally {
    asking = false
    if (again) {
      again = false
      void refresh()
    }
  }
}

/** The service's recent runs, followed while the calling component is mounted. */
export function useServiceRuns(): readonly SpecialistRun[] {
  useEffect(() => {
    if (watchers++ === 0) {
      const off = on('agents.specialistsChanged', () => void refresh())
      void refresh()
      stop = off
    }
    return () => {
      if (--watchers === 0) {
        stop?.()
        stop = null
      }
    }
  }, [])
  return useStore(store, (s) => s.runs)
}

/** The service runs this chat asked: its assistant (`agent`) or its own session file. */
export function chatServiceRuns(
  runs: readonly SpecialistRun[],
  file: string,
  agent: string | null,
): AgentRun[] {
  return runs
    .filter((r) =>
      r.caller.kind === 'assistant'
        ? agent !== null && r.caller.id === agent
        : r.caller.kind === 'chat' && file !== '' && r.caller.file === file,
    )
    .map((r) => ({
      run: r.run,
      agent: r.agent,
      status: r.status,
      ...(r.at === null ? {} : { startedAt: r.at }),
      ...(r.seconds === null ? {} : { seconds: r.seconds }),
      ...(r.cost === null ? {} : { cost: r.cost }),
      ...(r.error === null ? {} : { error: r.error }),
    }))
}

/** The badges a chat shows now: transcript and service runs joined, newest first, recent only. */
export function chatSpecialists(
  messages: readonly ChatMessage[],
  service: readonly AgentRun[],
  now: number,
): AgentRun[] {
  const transcript = messages.flatMap((m) => (m.agent === undefined ? [] : [m.agent]))
  return recentAgentRuns(liveAgentRuns(transcript, service), now)
}

/** The name Clear done hides a finished badge under (beside the subagents' names). */
export const specialistName = (run: AgentRun): string => `specialist:${agentRunKey(run)}`
