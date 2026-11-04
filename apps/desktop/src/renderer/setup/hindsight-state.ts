import type { HindsightStatus, SetupStep } from '@evaos/contract'
import { SETUP_STEPS } from '@evaos/contract'

/** What the memory step (and Settings) shows for the current Docker/container state. */
export type MemoryPhase =
  | 'checking'
  | 'docker-missing'
  | 'docker-down'
  /** Can be set up now. */
  | 'ready'
  /** Can be set up once an AI key is pasted. */
  | 'needs-key'
  /** Running, healthy and omp points at it. */
  | 'on'
  /** Container exists but is stopped, unhealthy, or omp does not point at it: Set up fixes it. */
  | 'repair'

export function memoryPhase(s: HindsightStatus | null): MemoryPhase {
  if (s === null) return 'checking'
  if (s.docker === 'missing') return 'docker-missing'
  if (s.docker === 'down') return 'docker-down'
  if (s.container === 'none') return s.llmReady ? 'ready' : 'needs-key'
  return s.container === 'running' && s.healthy && s.configured ? 'on' : 'repair'
}

/** Eva's profile is already set up by hand; the step only exists for the starter profile. */
export function visibleSteps(profile: 'eva' | 'starter'): readonly SetupStep[] {
  return profile === 'eva' ? SETUP_STEPS.filter((s) => s !== 'hindsight') : SETUP_STEPS
}

/** The neighbouring visible step, skipping `skips` on a rerun. */
export function neighbour(
  steps: readonly SetupStep[],
  from: SetupStep,
  dir: 1 | -1,
  skips: readonly SetupStep[] = [],
): SetupStep | undefined {
  let i = steps.indexOf(from) + dir
  while (steps[i] && skips.includes(steps[i]!)) i += dir
  return steps[i]
}
