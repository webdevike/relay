// The estimate itself, pure: a prior from how long similar past runs took, corrected live by how far
// this run has come (elapsed time, plan steps done, turn pace). Durations are skewed (most runs are
// short, a few run for hours), so everything is medians and quartiles, blended in log space.
import type { ActivityEta } from "@relay/protocol";
import type { PlanSteps, RunKey, RunRecord } from "./runs";

/** A bucket needs this many finished runs before it is trusted over a broader one. */
export const MIN_BUCKET_RUNS = 8;
/** Survivors (similar runs longer than this one already is) needed to read a conditional median. */
const MIN_SURVIVORS = 8;
/**
 * Pseudo-runs of the agent's whole history a bucket's survivors are blended with: a bucket with as
 * many survivors counts half. Replayed on held-out runs it cut task error a quarter through from
 * 0.49 to 0.45 and halfway from 0.20 to 0.18.
 */
const SHRINK_RUNS = 20;
/** Longer than this share of similar runs: overrunning. */
const OVERRUN_QUANTILE = 0.9;
/** Runs past a bucket's 90th percentile needed to read how heavy its tail is. */
const MIN_TAIL_RUNS = 5;
/** The tail index when no bucket has enough long runs: about how this machine's runs fall off. */
const DEFAULT_TAIL = 1.5;

export interface Bucket {
  /** Which fields matched: `agent=helper·role=helper-code·kind=build`, `agent=task` or `all`. */
  readonly level: string;
  /** Finished run lengths, ms, ascending. */
  readonly durations: readonly number[];
  /** Turns those runs took, ascending. */
  readonly turns: readonly number[];
  /**
   * How fast the runs past the 90th percentile fall off (a Pareto index fitted to them): given a
   * run has lasted `t` beyond them, its total is about `t * 2^(1/tail)`. NaN with too few.
   */
  readonly tail: number;
}

/**
 * Bucket levels, most specific first. Model and thinking level are recorded on every run but not
 * bucketed on: replaying the last fifth of history, model and thinking buckets raised the error
 * three quarters of the way through a task from 0.23 to 0.41 (thin buckets, and the model mix
 * shifts week to week). Who ran it (a helper's agent definition, an agent session's `--agent`)
 * does carry early on: replayed, it cut held-out helper error a tenth of the way through from 0.71
 * to 0.63 and task error a quarter through from 0.52 to 0.45 (late in long tasks it overshoots a
 * little more: 0.24 to 0.34 at three quarters).
 */
const LEVELS: readonly (readonly (keyof RunKey)[])[] = [["agent", "role", "kind"], ["agent", "role"], ["agent", "kind"], ["agent"], []];

const bucketId = (fields: readonly (keyof RunKey)[], key: RunKey): string => fields.map((field) => `${field}=${key[field] ?? "-"}`).join("·") || "all";

/** The Pareto index of the runs above the 90th percentile of `sorted`, NaN below `MIN_TAIL_RUNS`. */
export function tailIndex(sorted: readonly number[]): number {
  const p90 = quantile(sorted, OVERRUN_QUANTILE);
  let n = 0;
  let sum = 0;
  for (const value of sorted) {
    if (value <= p90) continue;
    n += 1;
    sum += Math.log(value / p90);
  }
  return n < MIN_TAIL_RUNS || sum <= 0 ? Number.NaN : Math.min(6, Math.max(0.8, n / sum));
}

/** Finished runs grouped at every level, for `bucketsFor`. Failed (cut short) runs are left out. */
export class RunIndex {
  private readonly groups = new Map<string, Bucket>();
  readonly size: number;

  constructor(runs: Iterable<RunRecord>) {
    const lists = new Map<string, { durations: number[]; turns: number[] }>();
    let size = 0;
    for (const run of runs) {
      if (run.outcome !== "done" || run.durationMs < 5000) continue;
      size += 1;
      for (const fields of LEVELS) {
        const id = bucketId(fields, run);
        let group = lists.get(id);
        if (group === undefined) {
          group = { durations: [], turns: [] };
          lists.set(id, group);
        }
        group.durations.push(run.durationMs);
        group.turns.push(run.turnAt.length);
      }
    }
    for (const [level, group] of lists) {
      group.durations.sort((a, b) => a - b);
      group.turns.sort((a, b) => a - b);
      this.groups.set(level, { level, durations: group.durations, turns: group.turns, tail: tailIndex(group.durations) });
    }
    this.size = size;
  }

  /** Every level that has runs, most specific first. */
  bucketsFor(key: RunKey): Bucket[] {
    const out: Bucket[] = [];
    for (const fields of LEVELS) {
      const group = this.groups.get(bucketId(fields, key));
      if (group !== undefined) out.push(group);
    }
    return out;
  }
}

/** Linear-interpolated quantile of an ascending list. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

/**
 * The `q` quantile of `sorted` with each value weighted by its inverse. A run looked at a random
 * moment is more likely a long one, so given only that it has lasted `t`, its total follows the
 * survivors' lengths weighted by 1/length (p(T | t) is proportional to f(T) / T for T > t), not the
 * plain survivors. On held-out runs this halved the error halfway through a task (0.89 to 0.23).
 */
export function seenQuantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  let sum = 0;
  for (const value of sorted) sum += 1 / Math.max(value, 1);
  const target = q * sum;
  let acc = 0;
  for (const value of sorted) {
    acc += 1 / Math.max(value, 1);
    if (acc >= target) return value;
  }
  return sorted[sorted.length - 1]!;
}

/** The values above `floor`, still ascending. */
function above(sorted: readonly number[], floor: number): readonly number[] {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= floor) lo = mid + 1;
    else hi = mid;
  }
  return sorted.slice(lo);
}

export interface LiveRun {
  readonly key: RunKey;
  /** When the run's request came in. */
  readonly from: number;
  readonly turns: number;
  readonly steps: PlanSteps | null;
  /** The longest it may run from `from` (an agent session's `--max-time`). */
  readonly limitMs?: number;
}

/** One estimate of the total, with its middle-half range, in log space for blending. */
interface Part {
  readonly total: number;
  readonly low: number;
  readonly high: number;
  readonly weight: number;
}

/** Rounds to 5 s under a minute, 15 s under ten and the minute above, so a push only goes out when it means something. */
export function roundMs(ms: number): number {
  const step = ms < 60_000 ? 5_000 : ms < 600_000 ? 15_000 : 60_000;
  return Math.max(step, Math.round(ms / step) * step);
}

/**
 * How far along a run is by what can be seen while it runs: with a plan, the share of steps done;
 * without one, elapsed over how long similar runs usually take. (Elapsed over the estimate's own
 * total says little: a history-only estimate sits around two thirds most of the way through.)
 */
export function stageOf(elapsedMs: number, typicalMs: number, steps: PlanSteps | null): number {
  return steps === null ? elapsedMs / Math.max(typicalMs, 1) : steps.done / steps.total;
}

/**
 * Whether estimates like this one have held up: replayed on held-out runs, the median error at this
 * stage (`stageOf`) for this agent, with or without a plan, was small (`ConfidenceTable`). Only then
 * is a badge solid.
 */
export type Trust = (key: RunKey, planned: boolean, stage: number) => boolean;

export interface EstimateOptions {
  /** Learned from calibration: actual over predicted for runs like this one (1 = unbiased). */
  readonly bias?: number;
  /** When an estimate may be drawn solid; without it every estimate is rough. */
  readonly trust?: Trust;
}

/**
 * The estimate for a live run at `now`, or null when nothing is known (no history and no plan).
 *
 * - History: the median length of similar runs that went on longer than this one already has,
 *   weighted by 1/length (`seenQuantile`), so it never says "done" for a run that is plainly going on.
 * - Past what history can say (few similar runs lasted this long): elapsed times how far runs past
 *   the 90th percentile went on (`Bucket.tail`), so the estimate climbs with elapsed time instead of
 *   parking at a fixed total.
 * - Plan: elapsed over the share of steps done, trusted more the further along it is.
 * - Pace: turns so far against the turns similar runs took, at this run's own time per turn.
 * - Limit: never past the run's `--max-time`.
 * - Overrunning: longer than nearly every similar run, or past what any history can say.
 */
export function estimateRun(index: RunIndex, run: LiveRun, now: number, options: EstimateOptions = {}): ActivityEta | null {
  const elapsed = Math.max(0, now - run.from);
  const buckets = index.bucketsFor(run.key);
  const prior = buckets.find((bucket) => bucket.durations.length >= MIN_BUCKET_RUNS) ?? null;
  const bias = Math.min(1.6, Math.max(0.6, options.bias ?? 1));
  const parts: Part[] = [];
  let overrunning = false;

  if (prior !== null) {
    const broader = buckets.slice(buckets.indexOf(prior));
    overrunning = elapsed > quantile(prior.durations, OVERRUN_QUANTILE) * bias;
    // The specific bucket's survivors when it has enough, else the first broader one that does.
    const lists = broader.map((bucket) => above(bucket.durations, elapsed / bias));
    const pick = lists.findIndex((list) => list.length >= MIN_SURVIVORS);
    const survivors = pick === -1 ? [] : lists[pick]!;
    // A thin specific bucket is shrunk toward the agent's whole history (`SHRINK_RUNS`).
    const agentAt = broader.findIndex((bucket) => bucket.level === `agent=${run.key.agent}`);
    const base = pick === -1 || agentAt <= pick || lists[agentAt]!.length < MIN_SURVIVORS ? null : lists[agentAt]!;
    const own = base === null ? 1 : survivors.length / (survivors.length + SHRINK_RUNS);
    const mix = (q: number): number => (base === null ? seenQuantile(survivors, q) : Math.exp(own * Math.log(seenQuantile(survivors, q)) + (1 - own) * Math.log(seenQuantile(base, q))));
    // As survivors thin out, the tail takes over smoothly: all of it below MIN_SURVIVORS.
    const tailWeight = Math.min(1, Math.max(0, (2 * MIN_SURVIVORS - survivors.length) / MIN_SURVIVORS));
    if (tailWeight < 1) {
      parts.push({ total: mix(0.5) * bias, low: mix(0.25) * bias, high: mix(0.75) * bias, weight: 1 - tailWeight });
    }
    if (tailWeight > 0) {
      const alpha = broader.map((bucket) => bucket.tail).find((tail) => Number.isFinite(tail)) ?? DEFAULT_TAIL;
      const t = Math.max(elapsed, 1);
      parts.push({ total: t * 2 ** (1 / alpha), low: t * (4 / 3) ** (1 / alpha), high: t * 4 ** (1 / alpha), weight: tailWeight });
      if (tailWeight === 1) overrunning = true;
    }
    const turnsLeft = above(prior.turns, run.turns);
    if (run.turns >= 3 && elapsed > 0 && turnsLeft.length >= MIN_SURVIVORS) {
      const perTurn = elapsed / run.turns;
      const at = (turns: number): number => elapsed + (turns - run.turns) * perTurn;
      parts.push({ total: at(seenQuantile(turnsLeft, 0.5)), low: at(seenQuantile(turnsLeft, 0.25)), high: at(seenQuantile(turnsLeft, 0.75)), weight: 0.5 });
    }
  }

  const steps = run.steps;
  if (steps !== null && steps.total >= 2 && steps.done >= 1 && elapsed > 0) {
    const share = steps.done / steps.total;
    if (steps.done >= steps.total) {
      parts.push({ total: elapsed * 1.05, low: elapsed, high: elapsed * 1.2, weight: 2 });
    } else {
      const total = elapsed / share;
      const spread = 1 + 1 / Math.sqrt(steps.done + 1);
      parts.push({ total, low: total / spread, high: total * spread, weight: 1.5 * share });
    }
    if (share >= 0.8) overrunning = false;
  }

  if (parts.length === 0) return null;
  const weight = parts.reduce((sum, part) => sum + part.weight, 0);
  const blend = (field: "total" | "low" | "high"): number => Math.exp(parts.reduce((sum, part) => sum + part.weight * Math.log(Math.max(1, part[field])), 0) / weight);
  const limit = run.limitMs ?? Number.POSITIVE_INFINITY;
  const total = Math.max(Math.min(blend("total"), limit), elapsed + 5_000);
  const low = Math.min(total, Math.max(blend("low"), elapsed));
  const high = Math.max(Math.min(blend("high"), limit), total);
  const runs = prior?.durations.length ?? 0;
  const typical = prior === null ? total : quantile(prior.durations, 0.5) * bias;
  const confident = !overrunning && (options.trust?.(run.key, steps !== null, stageOf(elapsed, typical, steps)) ?? false);
  return {
    from: run.from,
    totalMs: roundMs(total),
    lowMs: roundMs(low),
    highMs: roundMs(high),
    typicalMs: roundMs(typical),
    runs,
    confidence: confident ? "confident" : "rough",
    overrunning,
    ...(steps === null ? {} : { steps: { done: Math.min(steps.done, steps.total), total: steps.total } }),
  };
}
