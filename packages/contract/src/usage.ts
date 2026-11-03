import { z } from 'zod'

/** Providers the meter shows for every omp profile, in display order. */
export const USAGE_PROVIDERS = ['anthropic', 'openai-codex'] as const
export const UsageProviderSchema = z.enum(USAGE_PROVIDERS)
export type UsageProvider = z.infer<typeof UsageProviderSchema>

export const UsageWindowSchema = z.object({
  /** omp's limit id, for example `anthropic:7d:fable`. */
  id: z.string(),
  /** Display label, for example `7 days (Fable)`. */
  label: z.string(),
  usedFraction: z.number().min(0),
  /** Epoch ms; null when omp reports none. */
  resetsAt: z.number().nullable(),
  /** omp's status; anything but `ok` means the window is limited. */
  status: z.string(),
})
export type UsageWindow = z.infer<typeof UsageWindowSchema>

export const UsageAccountSchema = z.object({
  /** `<profile>:<provider>`. */
  key: z.string(),
  profile: z.string(),
  profileLabel: z.string(),
  provider: UsageProviderSchema,
  email: z.string().nullable(),
  windows: z.array(UsageWindowSchema),
  /** When omp fetched these windows (epoch ms); null when there never was data. */
  fetchedAt: z.number().nullable(),
  /** The last fetch failed and `windows` are from an earlier one. */
  stale: z.boolean(),
  /** Why the last fetch gave no data for this account; null when it succeeded. */
  error: z.string().nullable(),
})
export type UsageAccount = z.infer<typeof UsageAccountSchema>

export const UsageSnapshotSchema = z.object({
  accounts: z.array(UsageAccountSchema),
  /** When the last refresh finished (epoch ms); null before the first one. */
  updatedAt: z.number().nullable(),
  refreshing: z.boolean(),
})
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>

export const usageInvoke = {
  'usage.get': { input: z.object({}).strict(), output: UsageSnapshotSchema },
  'usage.refresh': { input: z.object({}).strict(), output: UsageSnapshotSchema },
} as const

export const usageEvents = {
  'usage.changed': UsageSnapshotSchema,
} as const
