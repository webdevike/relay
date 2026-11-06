import { z } from 'zod'

// Settings > Usage: what the omp sessions on the Relay Host cost and how they ran. Hand-ported
// from @relay/protocol stats.ts (the host's `stats.snapshot`); the host computes it in the
// background and the desktop only shows the cached snapshot.

export const STATS_RANGES = ['24h', '7d', '30d'] as const
export const StatsRangeKeySchema = z.enum(STATS_RANGES)
export type StatsRangeKey = z.infer<typeof StatsRangeKeySchema>

const count = z.number().int().min(0)

export const StatsTotalsSchema = z.object({
  requests: count,
  failed: count,
  costUsd: z.number(),
  unpriced: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  /** What the prompts would have cost without prompt caching, minus what they cost. */
  cacheSavingsUsd: z.number(),
  avgTtftMs: z.number().nullable(),
  tokensPerSecond: z.number().nullable(),
})
export type StatsTotals = z.infer<typeof StatsTotalsSchema>

export const StatsModelSchema = StatsTotalsSchema.extend({
  model: z.string(),
  provider: z.string(),
})
export type StatsModel = z.infer<typeof StatsModelSchema>

/** omp's session folder name: `-Eva-work-relay` is ~/Eva/work/relay. */
export const StatsFolderSchema = StatsTotalsSchema.extend({ folder: z.string() })
export type StatsFolder = z.infer<typeof StatsFolderSchema>

export const StatsAgentSchema = StatsTotalsSchema.extend({ agent: z.string(), label: z.string() })
export type StatsAgent = z.infer<typeof StatsAgentSchema>

export const StatsAgentTypeSchema = StatsTotalsSchema.extend({ type: z.enum(['main', 'subagent']) })
export type StatsAgentType = z.infer<typeof StatsAgentTypeSchema>

export const StatsPointSchema = z.object({
  at: z.number(),
  requests: count,
  failed: count,
  costUsd: z.number(),
  tokens: count,
})
export type StatsPoint = z.infer<typeof StatsPointSchema>

export const StatsRangeSchema = z.object({
  totals: StatsTotalsSchema,
  series: z.array(StatsPointSchema),
  byModel: z.array(StatsModelSchema),
  byFolder: z.array(StatsFolderSchema),
  byAgent: z.array(StatsAgentSchema),
  byAgentType: z.array(StatsAgentTypeSchema),
})
export type StatsRange = z.infer<typeof StatsRangeSchema>

export const StatsSnapshotSchema = z.object({
  updatedAt: z.number().nullable(),
  refreshing: z.boolean(),
  profiles: z.array(z.object({ name: z.string(), error: z.string().nullable() })),
  ranges: z
    .object({ '24h': StatsRangeSchema, '7d': StatsRangeSchema, '30d': StatsRangeSchema })
    .nullable(),
})
export type StatsSnapshot = z.infer<typeof StatsSnapshotSchema>

/** The page's view: the host's snapshot, or why there is none (no host, or one too old to answer). */
export const StatsViewSchema = z.object({
  stats: StatsSnapshotSchema.nullable(),
  /** Why `stats` is null; null when the host answered. */
  unavailable: z.string().nullable(),
})
export type StatsView = z.infer<typeof StatsViewSchema>

export const statsInvoke = {
  'stats.get': { input: z.object({}).strict(), output: StatsViewSchema },
} as const

export const statsEvents = {
  /** A new snapshot from the host (a refresh started or ended), or the host coming or going. */
  'stats.changed': StatsViewSchema,
} as const
