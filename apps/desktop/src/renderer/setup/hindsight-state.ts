import type { HindsightStatus, SetupStep } from '@evaos/contract'
import { SETUP_STEPS } from '@evaos/contract'

/** What the memory step (and Settings) shows for the current install state. */
export type MemoryPhase =
  | 'checking'
  /** Intel Mac without Docker: nothing can run it. */
  | 'docker-missing'
  | 'docker-down'
  /** Can be set up now. */
  | 'ready'
  /** Can be set up once an AI key is pasted. */
  | 'needs-key'
  /** Running, healthy and omp points at it. */
  | 'on'
  /** Installed but stopped, unhealthy, or omp does not point at it: Set up fixes it. */
  | 'repair'

/**
 * Relay's own install is the way in. Docker is only the way in on a Mac that cannot run it
 * (Intel), or an install that is already a Docker container.
 */
export function installEngine(s: HindsightStatus | null): 'native' | 'docker' {
  if (s === null) return 'native'
  if (s.engine !== 'none') return s.engine
  return s.nativeSupported ? 'native' : 'docker'
}

export function memoryPhase(s: HindsightStatus | null): MemoryPhase {
  if (s === null) return 'checking'
  if (s.engine === 'none') {
    if (installEngine(s) === 'docker') {
      if (s.docker === 'missing') return 'docker-missing'
      if (s.docker === 'down') return 'docker-down'
    }
    // Something to read with: a ChatGPT login, an AI key, or a model this Mac can run.
    return s.llm !== 'none' || s.local !== null ? 'ready' : 'needs-key'
  }
  return s.service === 'running' && s.healthy && s.configured ? 'on' : 'repair'
}

/**
 * After a native install fails, Docker is offered as a second try: only on a Mac where the failed
 * try was native and Docker can plausibly run (it was not found missing or stopped).
 */
export function offersDockerFallback(
  s: HindsightStatus | null,
  failedEngine: 'native' | 'docker' | null,
): boolean {
  return (
    s !== null &&
    failedEngine === 'native' &&
    s.engine !== 'docker' &&
    (s.docker === 'ok' || s.docker === 'unchecked')
  )
}

/** 1536 -> "1.5 KB", 2.1e9 -> "2.1 GB". Decimal units, like Finder. */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`
  return `${n} B`
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
