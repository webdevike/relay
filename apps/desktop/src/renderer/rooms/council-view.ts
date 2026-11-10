import {
  COUNCIL_DEFAULT_ROUTING,
  COUNCIL_MAX_EFFORT,
  COUNCIL_PAUSE_AT,
  type CouncilProvider,
  type CouncilRole,
  type CouncilRouting,
} from '@relay/protocol'
import type { RoomCouncil } from '@evaos/contract'

export type StepState = 'done' | 'now' | 'todo'

export interface PhaseStep {
  key: string
  label: string
  state: StepState
}

/** The in-round order: parts in parallel, look, integrate, critique, judge. */
const ROUND_STAGES = ['build', 'look', 'integrate', 'critique', 'judge'] as const

const stateAt = (i: number, now: number): StepState =>
  i < now ? 'done' : i === now ? 'now' : 'todo'

/**
 * Brief, Contract (split) or Plan, Round 1..N, Converge, Deliver, with the one the room is in
 * marked. A resolved room has finished them all.
 */
export function phaseSteps(
  c: Pick<RoomCouncil, 'stage' | 'round' | 'maxRounds' | 'parts'>,
  resolved: boolean,
): PhaseStep[] {
  const rounds = Math.max(1, c.maxRounds)
  const labels = [
    'Brief',
    c.parts.length > 1 ? 'Contract' : 'Plan',
    ...Array.from({ length: rounds }, (_, i) => `Round ${i + 1}`),
    'Converge',
    'Deliver',
  ]
  const round = Math.min(Math.max(c.round, 1), rounds)
  const at =
    c.stage === 'brief'
      ? 0
      : c.stage === 'contract' || c.stage === 'plan'
        ? 1
        : c.stage === 'converge'
          ? 2 + rounds
          : c.stage === 'deliver'
            ? 3 + rounds
            : 1 + round
  return labels.map((label, i) => ({
    key: label,
    label,
    state: resolved ? 'done' : stateAt(i, at),
  }))
}

/** The five moves of a round with the current one marked, or null outside a round. */
export function roundHint(stage: RoomCouncil['stage'], split: boolean): PhaseStep[] | null {
  const at = ROUND_STAGES.indexOf(stage as (typeof ROUND_STAGES)[number])
  if (at === -1) return null
  const labels = [split ? 'Parts in parallel' : 'Build', 'Look', 'Integrate', 'Critique', 'Judge']
  return labels.map((label, i) => ({ key: label, label, state: stateAt(i, at) }))
}

export interface SpendMeter {
  /** Spent as a share of the hard cap, 0..1. */
  ratio: number
  /** Where the estimate sits on the same bar, 0..1. */
  estimateAt: number
  /** At 80 % of the cap, or paused waiting on Continue / Wrap. */
  warn: boolean
}

export function spendMeter(
  spend: Pick<RoomCouncil['spend'], 'usd' | 'estimate' | 'cap'>,
  paused: boolean,
): SpendMeter {
  const cap = spend.cap > 0 ? spend.cap : 1
  return {
    ratio: Math.min(1, Math.max(0, spend.usd / cap)),
    estimateAt: Math.min(1, Math.max(0, spend.estimate / cap)),
    warn: paused || spend.usd >= cap * COUNCIL_PAUSE_AT,
  }
}

/** A live room goes up one notch at a time and never down; this keeps the slider inside that. */
export const clampRaise = (current: number, value: number): number =>
  Math.min(Math.max(value, current), Math.min(current + 1, COUNCIL_MAX_EFFORT))

/** The routing with one role pointed at a provider. */
export const withProvider = (
  routing: CouncilRouting,
  role: CouncilRole,
  provider: CouncilProvider,
): CouncilRouting => ({ ...routing, [role]: provider })

/** Routing in the full shape the contract wants (every role), whatever the room stored. */
export const fullRouting = (routing: Partial<CouncilRouting>): CouncilRouting => ({
  ...COUNCIL_DEFAULT_ROUTING,
  ...routing,
})

/** Only the roles moved off their default provider: what rooms.create takes. */
export const routingOverrides = (routing: CouncilRouting): Partial<CouncilRouting> =>
  Object.fromEntries(
    (Object.keys(routing) as CouncilRole[])
      .filter((r) => routing[r] !== COUNCIL_DEFAULT_ROUTING[r])
      .map((r) => [r, routing[r]]),
  )
