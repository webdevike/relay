// Stats: what the omp sessions on the host cost and how they ran, for the desktop's Settings > Usage.
//
// The host syncs every omp profile's transcripts with `omp stats --json` (which writes omp's own
// `stats.db`), reads that database for the last 24 hours, 7 days and 30 days, and keeps one merged
// snapshot in memory. Clients ask `stats.get` and get the cached `stats.snapshot` at once; the host
// refreshes in the background when the snapshot is older than STATS_STALE_MS and pushes the new one.
//
// Pure module: zod only, no imports from the rest of the protocol (index.ts re-exports it).
import { z } from "zod";

/** In `welcome.features` when the host answers `stats.get`. */
export const STATS_FEATURE = "stats";

/** A `stats.get` on a snapshot older than this starts a background refresh. */
export const STATS_STALE_MS = 5 * 60_000;

export const STATS_RANGES = ["24h", "7d", "30d"] as const;
export const StatsRangeKey = z.enum(STATS_RANGES);
export type StatsRangeKey = z.infer<typeof StatsRangeKey>;

const count = z.number().int().min(0);
const usd = z.number().finite();

/** Sums over a set of requests, and the speed averages over the requests that report them. */
export const StatsTotals = z.object({
  requests: count,
  /** Requests that ended in an error. */
  failed: count,
  costUsd: usd,
  /** Requests with tokens but no price (omp knows no price for the model). */
  unpriced: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  /** What the prompts would have cost without prompt caching, minus what they cost. */
  cacheSavingsUsd: usd,
  /** Mean time to first token (ms); null when no request reported one. */
  avgTtftMs: z.number().nullable(),
  /** Mean output tokens per second; null when no request reported a duration. */
  tokensPerSecond: z.number().nullable(),
});
export type StatsTotals = z.infer<typeof StatsTotals>;

export const StatsModel = StatsTotals.extend({ model: z.string(), provider: z.string() });
export type StatsModel = z.infer<typeof StatsModel>;

/** A working folder as omp names its session directory (`-Eva-work-relay` is ~/Eva/work/relay). */
export const StatsFolder = StatsTotals.extend({ folder: z.string() });
export type StatsFolder = z.infer<typeof StatsFolder>;

/** Who ran the requests: an assistant, a job, helpers, Claude Code or other (host-labeled). */
export const StatsAgent = StatsTotals.extend({ agent: z.string(), label: z.string() });
export type StatsAgent = z.infer<typeof StatsAgent>;

/** omp's split: requests of top-level sessions (`main`) and of the subagents they spawned. */
export const StatsAgentType = StatsTotals.extend({ type: z.enum(["main", "subagent"]) });
export type StatsAgentType = z.infer<typeof StatsAgentType>;

/** One bucket of the series: an hour for 24h, a local day for 7d and 30d. */
export const StatsPoint = z.object({
  /** Bucket start (epoch ms). */
  at: z.number(),
  requests: count,
  failed: count,
  costUsd: usd,
  tokens: count,
});
export type StatsPoint = z.infer<typeof StatsPoint>;

export const StatsRange = z.object({
  totals: StatsTotals,
  /** Oldest first, every bucket of the range present (empty ones are zeros). */
  series: z.array(StatsPoint),
  /** Costliest first. */
  byModel: z.array(StatsModel),
  /** Costliest first, the top STATS_MAX_FOLDERS. */
  byFolder: z.array(StatsFolder),
  /** Costliest first; empty when the host cannot tell who ran a session. */
  byAgent: z.array(StatsAgent),
  byAgentType: z.array(StatsAgentType),
});
export type StatsRange = z.infer<typeof StatsRange>;

export const STATS_MAX_FOLDERS = 12;

/** One omp profile the snapshot covers (`default` is the unnamed one at ~/.omp/agent). */
export const StatsProfile = z.object({
  name: z.string(),
  /** Why this profile's numbers are missing or old; null when its last read worked. */
  error: z.string().nullable(),
});
export type StatsProfile = z.infer<typeof StatsProfile>;

export const StatsSnapshot = z.object({
  /** When the last refresh finished (epoch ms); null before the first one. */
  updatedAt: z.number().nullable(),
  refreshing: z.boolean(),
  profiles: z.array(StatsProfile),
  /** null before the first refresh finished. */
  ranges: z.object({ "24h": StatsRange, "7d": StatsRange, "30d": StatsRange }).nullable(),
});
export type StatsSnapshot = z.infer<typeof StatsSnapshot>;
