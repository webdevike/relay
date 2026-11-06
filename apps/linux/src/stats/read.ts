// Reads omp's own stats database (`stats.db`, written by `omp stats`) into the protocol's stats
// ranges. omp's `--json` answers only the last 24 hours and nothing per session, so the host reads
// the `messages` table itself (one row per model request, the same rows omp's dashboard sums) for
// 24 hours, 7 days and 30 days, and merges the rows of every omp profile.

import {
  STATS_MAX_FOLDERS,
  type StatsAgent,
  type StatsPoint,
  type StatsRange,
  type StatsRangeKey,
  type StatsTotals,
} from "@relay/protocol";

/** A read-only handle on one profile's stats.db. */
export interface StatsDb {
  all(sql: string, ...params: number[]): Record<string, unknown>[];
  close(): void;
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** What a range covers: the cutoff, the series' buckets and the local-time offset they align to. */
export interface RangeWindow {
  key: StatsRangeKey;
  /** Requests at or after this count (epoch ms). */
  cutoff: number;
  /** The first series bucket: the cutoff's bucket, so the first one may be partial. */
  start: number;
  bucketMs: number;
  /** Added to epoch ms before bucketing so days start at local midnight. */
  offsetMs: number;
}

/** The three windows at `now`: the last 24 hours by the hour, then 7 and 30 local days (today last). */
export function rangeWindows(now: number, offsetMs: number): RangeWindow[] {
  const today = Math.floor((now + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  const dayAgo = now - DAY_MS;
  const days = (n: number): RangeWindow => {
    const cutoff = today - (n - 1) * DAY_MS;
    return { key: n === 7 ? "7d" : "30d", cutoff, start: cutoff, bucketMs: DAY_MS, offsetMs };
  };
  return [
    { key: "24h", cutoff: dayAgo, start: Math.floor((dayAgo + offsetMs) / HOUR_MS) * HOUR_MS - offsetMs, bucketMs: HOUR_MS, offsetMs },
    days(7),
    days(30),
  ];
}

/** Additive sums for one group of requests; averages come from the sum and count pairs. */
export interface Sums {
  requests: number;
  failed: number;
  costUsd: number;
  unpriced: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Prompt cost as if nothing were cached (only requests omp could price both ways). */
  noCacheCost: number;
  /** What those same prompts did cost. */
  cachedCost: number;
  ttftSum: number;
  ttftN: number;
  tpsSum: number;
  tpsN: number;
}

/** Requests of one model in one session (with its folder and main/subagent). */
export interface Cell extends Sums {
  model: string;
  provider: string;
  folder: string;
  agentType: "main" | "subagent";
  sessionFile: string;
}

// The sums mirror omp's rollup (packages/stats rollup.ts), unpriced included.
const SUMS = `
COUNT(*) AS requests,
SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS failed,
TOTAL(cost_total) AS cost,
SUM(CASE WHEN total_tokens > 0 AND cost_total = 0 AND (provider = 'xai-oauth' OR cost_unpriced = 1) THEN 1 ELSE 0 END) AS unpriced,
SUM(input_tokens) AS input_tokens,
SUM(output_tokens) AS output_tokens,
SUM(cache_read_tokens) AS cache_read_tokens,
SUM(cache_write_tokens) AS cache_write_tokens,
TOTAL(cost_no_cache_input) AS no_cache_cost,
TOTAL(CASE WHEN cost_no_cache_input > 0 THEN cost_input + cost_cache_read + cost_cache_write ELSE 0 END) AS cached_cost,
TOTAL(ttft) AS ttft_sum,
COUNT(ttft) AS ttft_n,
TOTAL(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration END) AS tps_sum,
COUNT(CASE WHEN duration > 0 THEN 1 END) AS tps_n`;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function sumsOf(row: Record<string, unknown>): Sums {
  return {
    requests: num(row["requests"]),
    failed: num(row["failed"]),
    costUsd: num(row["cost"]),
    unpriced: num(row["unpriced"]),
    inputTokens: num(row["input_tokens"]),
    outputTokens: num(row["output_tokens"]),
    cacheReadTokens: num(row["cache_read_tokens"]),
    cacheWriteTokens: num(row["cache_write_tokens"]),
    noCacheCost: num(row["no_cache_cost"]),
    cachedCost: num(row["cached_cost"]),
    ttftSum: num(row["ttft_sum"]),
    ttftN: num(row["ttft_n"]),
    tpsSum: num(row["tps_sum"]),
    tpsN: num(row["tps_n"]),
  };
}

/** Requests since `cutoff`, one cell per session and model. */
export function readCells(db: StatsDb, cutoff: number): Cell[] {
  return db
    .all(
      `SELECT model, provider, folder, agent_type, session_file, ${SUMS}
FROM messages WHERE timestamp >= ? GROUP BY model, provider, folder, agent_type, session_file`,
      cutoff,
    )
    .map((row) => ({
      ...sumsOf(row),
      model: str(row["model"]),
      provider: str(row["provider"]),
      folder: str(row["folder"]),
      agentType: row["agent_type"] === "main" ? "main" : "subagent",
      sessionFile: str(row["session_file"]),
    }));
}

/** Requests since `w.cutoff` per series bucket (only buckets that have any). */
export function readSeries(db: StatsDb, w: RangeWindow): StatsPoint[] {
  return db
    .all(
      `SELECT CAST((timestamp + ?) / ? AS INTEGER) * ? - ? AS bucket, COUNT(*) AS requests,
SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS failed, TOTAL(cost_total) AS cost, SUM(total_tokens) AS tokens
FROM messages WHERE timestamp >= ? GROUP BY 1`,
      w.offsetMs,
      w.bucketMs,
      w.bucketMs,
      w.offsetMs,
      w.cutoff,
    )
    .map((row) => ({
      at: num(row["bucket"]),
      requests: num(row["requests"]),
      failed: num(row["failed"]),
      costUsd: num(row["cost"]),
      tokens: num(row["tokens"]),
    }));
}

const ZERO: Sums = {
  requests: 0,
  failed: 0,
  costUsd: 0,
  unpriced: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  noCacheCost: 0,
  cachedCost: 0,
  ttftSum: 0,
  ttftN: 0,
  tpsSum: 0,
  tpsN: 0,
};

function add(into: Sums, s: Sums): void {
  for (const k of Object.keys(ZERO) as (keyof Sums)[]) into[k] += s[k];
}

export function totalsOf(s: Sums): StatsTotals {
  return {
    requests: s.requests,
    failed: s.failed,
    costUsd: s.costUsd,
    unpriced: s.unpriced,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    cacheSavingsUsd: s.noCacheCost > 0 ? s.noCacheCost - s.cachedCost : 0,
    avgTtftMs: s.ttftN > 0 ? s.ttftSum / s.ttftN : null,
    tokensPerSecond: s.tpsN > 0 ? s.tpsSum / s.tpsN : null,
  };
}

/** Cells summed per `key`, costliest first (then most requests). */
function groupBy<K>(cells: readonly Cell[], key: (c: Cell) => K | null): { key: K; totals: StatsTotals }[] {
  const groups = new Map<string, { key: K; sums: Sums }>();
  for (const c of cells) {
    const k = key(c);
    if (k === null) continue;
    const id = JSON.stringify(k);
    let g = groups.get(id);
    if (g === undefined) {
      g = { key: k, sums: { ...ZERO } };
      groups.set(id, g);
    }
    add(g.sums, c);
  }
  return [...groups.values()]
    .map((g) => ({ key: g.key, totals: totalsOf(g.sums) }))
    .sort((a, b) => b.totals.costUsd - a.totals.costUsd || b.totals.requests - a.totals.requests);
}

/** Who ran a session: the agent id and its label, or null when unknown. */
export type AgentOf = (sessionFile: string, agentType: Cell["agentType"]) => { agent: string; label: string } | null;

/** One range from every profile's cells and series points; the series gets every bucket, zeros included. */
export function buildRange(w: RangeWindow, now: number, cells: readonly Cell[], points: readonly StatsPoint[], agentOf: AgentOf | null): StatsRange {
  const all = { ...ZERO };
  for (const c of cells) add(all, c);

  const byAt = new Map<number, StatsPoint>();
  for (let at = w.start; at <= now; at += w.bucketMs) byAt.set(at, { at, requests: 0, failed: 0, costUsd: 0, tokens: 0 });
  for (const p of points) {
    const slot = byAt.get(p.at);
    if (slot === undefined) continue;
    slot.requests += p.requests;
    slot.failed += p.failed;
    slot.costUsd += p.costUsd;
    slot.tokens += p.tokens;
  }

  const labels = new Map<string, string>();
  const byAgent: StatsAgent[] =
    agentOf === null
      ? []
      : groupBy(cells, (c) => {
          const who = agentOf(c.sessionFile, c.agentType);
          if (who === null) return null;
          labels.set(who.agent, who.label);
          return who.agent;
        }).map((g) => ({ agent: g.key, label: labels.get(g.key) ?? g.key, ...g.totals }));

  return {
    totals: totalsOf(all),
    series: [...byAt.values()],
    byModel: groupBy(cells, (c) => [c.model, c.provider] as const).map((g) => ({
      model: g.key[0],
      provider: g.key[1],
      ...g.totals,
    })),
    byFolder: groupBy(cells, (c) => c.folder)
      .slice(0, STATS_MAX_FOLDERS)
      .map((g) => ({ folder: g.key, ...g.totals })),
    byAgent,
    byAgentType: groupBy(cells, (c) => c.agentType).map((g) => ({ type: g.key, ...g.totals })),
  };
}
