import type { Assistant, SpecialistCaller, SpecialistRuns } from '@evaos/contract'
import { costLabel } from '../chat/RunDetails'

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

/** The heading's one line: `12 runs in 7 days, $0.17`, or that none ran. */
export function specialistsSummary(data: SpecialistRuns): string {
  const calls = data.agents.reduce((n, a) => n + a.calls, 0)
  const cost = data.agents.reduce((n, a) => n + a.cost, 0)
  if (calls === 0) return `No runs in ${String(data.days)} days`
  const runs = `${String(calls)} ${calls === 1 ? 'run' : 'runs'} in ${String(data.days)} days`
  return cost > 0 ? `${runs}, ${costLabel(cost)}` : runs
}
