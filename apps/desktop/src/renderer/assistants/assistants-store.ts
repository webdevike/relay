import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import type { Assistant, Assistants } from '@evaos/contract'
import type { Place } from '@evaos/shell-core'
import { setAgentTitles } from '../eva/names-store'
import { invoke, on } from '../ipc'
import { registerReloader } from '../reload/reload'

export interface AssistantsState {
  /** Main's last list; null until the first arrives. */
  data: Assistants | null
  /** Agents a Start is on its way for. */
  starting: Record<string, true>
  /** Why Relay could not start an agent, by agent id. */
  failed: Record<string, string>
}

export const assistantsStore = createStore<AssistantsState>(() => ({
  data: null,
  starting: {},
  failed: {},
}))

export function useAssistants<T>(selector: (s: AssistantsState) => T): T {
  return useStore(assistantsStore, selector)
}

/** The registry agent id an `agent:<id>` place shows, else null. */
export function agentIdOf(place: Place): string | null {
  return place.page.startsWith('agent:') ? place.page.slice('agent:'.length) : null
}

/** The agent `id` in the last list, if the registry has it. */
export function agentOf(s: AssistantsState, id: string): Assistant | null {
  return s.data?.agents.find((a) => a.id === id) ?? null
}

/**
 * The session file an agent place shows in main's chat pane: its thread once omp wrote it, null
 * while the page is the start card (or the place is not an agent's).
 */
export function agentFile(s: AssistantsState, place: Place): string | null {
  const id = agentIdOf(place)
  return id === null ? null : (agentOf(s, id)?.file ?? null)
}

function apply(data: Assistants): void {
  assistantsStore.setState({ data })
  setAgentTitles(Object.fromEntries(data.agents.map((a) => [a.id, a.title])))
}

async function load(): Promise<void> {
  const r = await invoke('assistants.list', {})
  if (r.ok) apply(r.value)
}

/** Native start_assistant: "Hi <Title>" through Relay; the next list carries the thread. */
export async function startAgent(id: string): Promise<void> {
  assistantsStore.setState((s) => {
    const failed = { ...s.failed }
    delete failed[id]
    return { starting: { ...s.starting, [id]: true }, failed }
  })
  const r = await invoke('assistants.start', { agent: id })
  assistantsStore.setState((s) => {
    const starting = { ...s.starting }
    delete starting[id]
    return r.ok ? { starting } : { starting, failed: { ...s.failed, [id]: r.error.message } }
  })
}

export function startAssistants(): () => void {
  const off = on('assistants.changed', apply)
  // The registry rereads with the rest of Eva's repo (the refresh shortcut, window focus); main
  // pushes thread changes itself.
  const offReload = registerReloader('assistants', load, [])
  void load()
  return () => {
    off()
    offReload()
  }
}
