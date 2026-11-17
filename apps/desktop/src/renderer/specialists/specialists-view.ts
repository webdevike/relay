import type {
  Assistant,
  SpecialistAgent,
  SpecialistCaller,
  SpecialistRun,
  SpecialistSaved,
} from '@evaos/contract'
import type { ListTone } from '../ui/list'

/** The registry assistant a caller is, when it is one. */
export function callerAssistant(
  caller: SpecialistCaller,
  assistants: readonly Assistant[],
): Assistant | null {
  return caller.kind === 'assistant' ? (assistants.find((a) => a.id === caller.id) ?? null) : null
}

/** A caller as the page names it: the assistant's title, the chat's title, the name it gave, or that nobody said. */
export function callerName(caller: SpecialistCaller, assistants: readonly Assistant[]): string {
  switch (caller.kind) {
    case 'assistant':
      return (
        callerAssistant(caller, assistants)?.title ??
        caller.id.charAt(0).toUpperCase() + caller.id.slice(1)
      )
    case 'chat':
      return caller.title ?? 'A chat'
    case 'other':
      return caller.label
    case 'none':
      return 'Caller not recorded'
  }
}

/** A run's second line: who asked, else the job that ran on its own (a schedule, an event). */
export function runOrigin(run: SpecialistRun, assistants: readonly Assistant[]): string {
  if (run.caller.kind !== 'none') return `Asked by ${callerName(run.caller, assistants)}`
  return run.job === null ? 'Caller not recorded' : `${run.job} job`
}

/** A model id as people read it: without its provider (`claude-sonnet-5-5`). */
export const modelName = (model: string): string => model.slice(model.lastIndexOf('/') + 1)

/**
 * What an agent's row says about it, loudest first: running now, its file does not load, turned
 * off, in shadow (it runs and records, nothing acts on it), on trial (each request runs on every
 * trial model for Isaac's blind pick); null for a live agent at rest.
 */
export function agentStatus(a: SpecialistAgent): { label: string; tone: ListTone } | null {
  if (a.runs.running > 0) return { label: 'Running', tone: 'info' }
  if (a.error !== null) return { label: 'Does not load', tone: 'bad' }
  if (!a.enabled || a.mode === 'off') return { label: 'Off', tone: 'dim' }
  if (a.mode === 'shadow') return { label: 'Shadow', tone: 'warn' }
  if (a.trial.on) return { label: 'Trial', tone: 'accent' }
  return null
}

/** The heading's one line: how many agents, and how many run now or do not load. */
export function agentsSummary(agents: readonly SpecialistAgent[]): string {
  const running = agents.filter((a) => a.runs.running > 0).length
  const broken = agents.filter((a) => a.error !== null).length
  return [
    `${String(agents.length)} ${agents.length === 1 ? 'agent' : 'agents'}`,
    running > 0 ? `${String(running)} running` : null,
    broken > 0 ? `${String(broken)} not loading` : null,
  ]
    .filter(Boolean)
    .join(', ')
}

/** How the editor's save line reads an outcome: quiet when it landed, loud when it did not. */
export const savedTone = (s: SpecialistSaved): 'ok' | 'warn' | 'bad' =>
  s.state === 'committed' || s.state === 'unchanged' ? 'ok' : s.state === 'kept' ? 'warn' : 'bad'
