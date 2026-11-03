import { USAGE_PROVIDERS, type UsageAccount, type UsageSnapshot } from '@evaos/contract'
import type { CaptureResult } from '../eva/spawn'
import { discoverProfiles, failureReason, mergeProfile, parseUsageOutput } from './usage'

export const USAGE_POLL_MS = 5 * 60_000
export const USAGE_FOCUS_MIN_MS = 60_000
export const USAGE_TIMEOUT_MS = 20_000

export interface UsageServiceDeps {
  profilesDir: string
  /** Runs `omp --profile <profile> usage --json` with the given deadline. */
  run: (profile: string, timeoutMs: number) => Promise<CaptureResult>
  emit: (snapshot: UsageSnapshot) => void
  now?: () => number
  timeoutMs?: number
}

export interface UsageService {
  get(): UsageSnapshot
  /** One refresh at a time; a call during one joins it. Never rejects. */
  refresh(): Promise<UsageSnapshot>
  /** Refreshes when the last one finished more than a minute ago. */
  refreshIfOld(): void
}

/** Accounts for every profile under `profilesDir` (read on each refresh), provider-major order. */
export function createUsageService(deps: UsageServiceDeps): UsageService {
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? USAGE_TIMEOUT_MS
  let accounts: UsageAccount[] = []
  let updatedAt: number | null = null
  let inflight: Promise<UsageSnapshot> | null = null

  const snapshot = (): UsageSnapshot => ({ accounts, updatedAt, refreshing: inflight !== null })

  const fetchProfile = async (profile: string, previous: readonly UsageAccount[]) => {
    const r = await deps.run(profile, timeoutMs).catch((e: unknown): CaptureResult => ({
      code: null,
      stdout: '',
      stderr: e instanceof Error ? e.message : String(e),
      timedOut: false,
    }))
    const usage = !r.timedOut && r.code === 0 ? parseUsageOutput(r.stdout) : null
    if (usage) return mergeProfile(previous, profile, { ok: true, usage })
    const reason =
      !r.timedOut && r.code === 0
        ? 'omp usage printed output Relay could not read'
        : failureReason(r, timeoutMs)
    return mergeProfile(previous, profile, { ok: false, reason })
  }

  const refresh = (): Promise<UsageSnapshot> => {
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const previous = accounts
        const profiles = discoverProfiles(deps.profilesDir)
        const perProfile = (
          await Promise.all(profiles.map((p) => fetchProfile(p, previous)))
        ).flat()
        // Provider-major: Claude for each profile, then Codex for each profile.
        accounts = USAGE_PROVIDERS.flatMap((p) => perProfile.filter((a) => a.provider === p))
        updatedAt = now()
      } finally {
        inflight = null
      }
      const done = snapshot()
      deps.emit(done)
      return done
    })()
    deps.emit(snapshot())
    return inflight
  }

  return {
    get: snapshot,
    refresh,
    refreshIfOld: () => {
      if (updatedAt === null || now() - updatedAt > USAGE_FOCUS_MIN_MS) void refresh()
    },
  }
}
