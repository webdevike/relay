import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import {
  USAGE_PROVIDERS,
  type UsageAccount,
  type UsageProvider,
  type UsageWindow,
} from '@relay/protocol'

// `omp usage --json`: only the fields the meter reads; everything else is ignored.
const LimitSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  scope: z.object({ tier: z.string().optional() }).optional(),
  window: z
    .object({
      label: z.string().optional(),
      durationMs: z.number().optional(),
      resetsAt: z.number().nullable().optional(),
    })
    .optional(),
  amount: z.object({
    usedFraction: z.number().optional(),
    used: z.number().optional(),
    limit: z.number().optional(),
  }),
  status: z.string().optional(),
})
const ReportSchema = z.object({
  provider: z.string(),
  fetchedAt: z.number().optional(),
  limits: z.array(z.unknown()),
  metadata: z.object({ email: z.string().optional() }).optional(),
})
const OutputSchema = z.object({
  generatedAt: z.number().optional(),
  reports: z.array(z.unknown()),
  accountsWithoutUsage: z.array(z.unknown()).optional(),
  disabledCredentials: z.array(z.unknown()).optional(),
})

export interface ProviderUsage {
  email: string | null
  fetchedAt: number
  windows: UsageWindow[]
}

/** One profile's parsed output: usage per provider, or why a provider has none. */
export interface ProfileUsage {
  providers: Partial<Record<UsageProvider, ProviderUsage>>
  missing: Partial<Record<UsageProvider, string>>
}

export const PROVIDER_NAMES: Record<UsageProvider, string> = {
  anthropic: 'Claude',
  'openai-codex': 'Codex',
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** `5 hours`, `7 days`, plus a tier such as `(Fable)`; omp's own label when there is no duration. */
export function windowLabel(limit: z.infer<typeof LimitSchema>): string {
  const ms = limit.window?.durationMs
  let base: string
  if (ms !== undefined && ms > 0 && ms % DAY === 0) {
    const d = ms / DAY
    base = `${d} ${d === 1 ? 'day' : 'days'}`
  } else if (ms !== undefined && ms > 0 && ms % HOUR === 0) {
    const h = ms / HOUR
    base = `${h} ${h === 1 ? 'hour' : 'hours'}`
  } else {
    base = limit.window?.label ?? limit.label ?? limit.id
  }
  const tier = limit.scope?.tier
  return tier ? `${base} (${tier.charAt(0).toUpperCase()}${tier.slice(1)})` : base
}

function toWindow(raw: unknown): UsageWindow | null {
  const parsed = LimitSchema.safeParse(raw)
  if (!parsed.success) return null
  const l = parsed.data
  const { usedFraction, used, limit } = l.amount
  const fraction =
    usedFraction ?? (used !== undefined && limit !== undefined && limit > 0 ? used / limit : NaN)
  if (!Number.isFinite(fraction)) return null
  return {
    id: l.id,
    label: windowLabel(l),
    usedFraction: Math.max(0, fraction),
    resetsAt: l.window?.resetsAt ?? null,
    status: l.status ?? 'ok',
  }
}

const mentions = (list: readonly unknown[] | undefined, provider: string): boolean =>
  (list ?? []).some((e) =>
    typeof e === 'string'
      ? e === provider || e.startsWith(`${provider}:`)
      : typeof e === 'object' && e !== null && 'provider' in e && e.provider === provider,
  )

/** Parses `omp usage --json`; null when the output is not that document. */
export function parseUsageOutput(stdout: string): ProfileUsage | null {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return null
  }
  const doc = OutputSchema.safeParse(json)
  if (!doc.success) return null
  const out: ProfileUsage = { providers: {}, missing: {} }
  for (const raw of doc.data.reports) {
    const r = ReportSchema.safeParse(raw)
    if (!r.success) continue
    const provider = USAGE_PROVIDERS.find((p) => p === r.data.provider)
    if (!provider || out.providers[provider]) continue
    const windows = r.data.limits.map(toWindow).filter((w): w is UsageWindow => w !== null)
    if (windows.length === 0) continue
    out.providers[provider] = {
      email: r.data.metadata?.email ?? null,
      fetchedAt: r.data.fetchedAt ?? doc.data.generatedAt ?? Date.now(),
      windows,
    }
  }
  for (const provider of USAGE_PROVIDERS) {
    if (out.providers[provider]) continue
    const name = PROVIDER_NAMES[provider]
    out.missing[provider] = mentions(doc.data.disabledCredentials, provider)
      ? `omp has the ${name} credential disabled`
      : mentions(doc.data.accountsWithoutUsage, provider)
        ? `omp reports no ${name} usage for this account`
        : `No ${name} account in this profile`
  }
  return out
}

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Profile folder names under `dir`, sorted; empty when the folder is missing. */
export function discoverProfiles(dir: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => PROFILE_RE.test(e.name) && isDir(path.join(dir, e.name), e))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
}

function isDir(full: string, e: fs.Dirent): boolean {
  if (e.isDirectory()) return true
  if (!e.isSymbolicLink()) return false
  try {
    return fs.statSync(full).isDirectory()
  } catch {
    return false
  }
}

/** `personal` shows as `Personal`. */
export const profileLabel = (profile: string): string =>
  profile.charAt(0).toUpperCase() + profile.slice(1)

export type FetchOutcome = { ok: true; usage: ProfileUsage } | { ok: false; reason: string }

/**
 * One profile's accounts after a fetch, provider order. A failed fetch (or a provider missing
 * from a good one) keeps the account's last good windows, marked stale, with the reason.
 */
export function mergeProfile(
  previous: readonly UsageAccount[],
  profile: string,
  outcome: FetchOutcome,
): UsageAccount[] {
  return USAGE_PROVIDERS.map((provider) => {
    const key = `${profile}:${provider}`
    const base = { key, profile, profileLabel: profileLabel(profile), provider }
    const fresh = outcome.ok ? outcome.usage.providers[provider] : undefined
    if (fresh) {
      return {
        ...base,
        email: fresh.email,
        windows: fresh.windows,
        fetchedAt: fresh.fetchedAt,
        stale: false,
        error: null,
      }
    }
    const reason = outcome.ok
      ? (outcome.usage.missing[provider] ?? 'No usage reported')
      : outcome.reason
    const prior = previous.find((a) => a.key === key)
    if (prior && prior.windows.length > 0) return { ...prior, ...base, stale: true, error: reason }
    return {
      ...base,
      email: prior?.email ?? null,
      windows: [],
      fetchedAt: null,
      stale: false,
      error: reason,
    }
  })
}

/** Why a finished `omp usage` run gave no document. */
export function failureReason(
  r: { code: number | null; stderr: string; timedOut: boolean },
  timeoutMs: number,
): string {
  if (r.timedOut) return `omp usage timed out after ${Math.round(timeoutMs / 1000)} s`
  const last = r.stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  if (last) return last.length > 200 ? `${last.slice(0, 199)}…` : last
  return r.code === null ? 'omp usage could not start' : `omp usage exited with code ${r.code}`
}
