// The estimate itself, pure: a prior from how long similar past runs took, corrected live by how far
// this run has come (elapsed time, plan steps done, turn pace). Durations are skewed (most runs are
// short, a few run for hours), so everything is medians and quartiles, blended in log space.
import type { ActivityEta } from "@relay/protocol";
import type { PlanSteps, RunKey, RunRecord } from "./runs";

/** A bucket needs this many finished runs before it is trusted over a broader one. */
export const MIN_BUCKET_RUNS = 8;
/** Survivors (similar runs longer than this one already is) needed to read a conditional median. */
const MIN_SURVIVORS = 8;
/** Longer than this share of similar runs: overrunning. */
const OVERRUN_QUANTILE = 0.9;

export interface Bucket {
  /** Which fields matched: `agent=task·kind=build`, `agent=task` or `all`. */
  readonly level: string;
  /** Finished run lengths, ms, ascending. */
  readonly durations: readonly number[];
  /** Turns those runs took, ascending. */
  readonly turns: readonly number[];
}

/**
 * Bucket levels, most specific first. Model and thinking level are recorded on every run but not
 * bucketed on: replaying the last fifth of history, model and thinking buckets raised the error
 * three quarters of the way through a task from 0.23 to 0.41 (thin buckets, and the model mix
 * shifts week to week), while kind and agent held up.
 */
const LEVELS: readonly (readonly (keyof RunKey)[])[] = [["agent", "kind"], ["agent"], []];

const bucketId = (fields: readonly (keyof RunKey)[], key: RunKey): string => fields.map((field) => `${field}=${key[field] ?? "-"}`).join("·") || "all";

/** Finished runs grouped at every level, for `bucketsFor`. Failed (cut short) runs are left out. */
export class RunIndex {
  private readonly groups = new Map<string, { durations: number[]; turns: number[] }>();
  readonly size: number;

  constructor(runs: Iterable<RunRecord>) {
    let size = 0;
    for (const run of runs) {
      if (run.outcome !== "done" || run.durationMs < 5000) continue;
      size += 1;
      for (const fields of LEVELS) {
        const id = bucketId(fields, run);
        let group = this.groups.get(id);
        if (group === undefined) {
          group = { durations: [], turns: [] };
          this.groups.set(id, group);
        }
        group.durations.push(run.durationMs);
        group.turns.push(run.turnAt.length);
      }
    }
    for (const group of this.groups.values()) {
      group.durations.sort((a, b) => a - b);
      group.turns.sort((a, b) => a - b);
    }
    this.size = size;
  }

  /** Every level that has runs, most specific first. */
  bucketsFor(key: RunKey): Bucket[] {
    const out: Bucket[] = [];
    for (const fields of LEVELS) {
      const level = bucketId(fields, key);
      const group = this.groups.get(level);
      if (group !== undefined) out.push({ level, durations: group.durations, turns: group.turns });
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

export interface EstimateOptions {
  /** Learned from calibration: actual over predicted for runs like this one (1 = unbiased). */
  readonly bias?: number;
}

/**
 * The estimate for a live run at `now`, or null when nothing is known (no history and no plan).
 *
 * - History: the median length of similar runs that went on longer than this one already has,
 *   weighted by 1/length (`seenQuantile`), so it never says "done" for a run that is plainly going on.
 * - Plan: elapsed over the share of steps done, trusted more the further along it is.
 * - Pace: turns so far against the turns similar runs took, at this run's own time per turn.
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
    overrunning = elapsed > quantile(prior.durations, OVERRUN_QUANTILE) * bias;
    // The specific bucket's survivors when it has enough, else the first broader one that does.
    const survivors = [prior, ...buckets.slice(buckets.indexOf(prior) + 1)].map((bucket) => above(bucket.durations, elapsed / bias)).find((list) => list.length >= MIN_SURVIVORS);
    if (survivors === undefined) {
      overrunning = true;
      parts.push({ total: elapsed * 1.25, low: elapsed * 1.05, high: elapsed * 2, weight: 1 });
    } else {
      parts.push({ total: seenQuantile(survivors, 0.5) * bias, low: seenQuantile(survivors, 0.25) * bias, high: seenQuantile(survivors, 0.75) * bias, weight: 1 });
    }
    const turnsLeft = above(prior.turns, run.turns);
    if (run.turns >= 3 && elapsed > 0 && turnsLeft.length >= MIN_SURVIVORS) {
      const perTurn = elapsed / run.turns;
      const at = (turns: number): number => elapsed + (turns - run.turns) * perTurn;
      parts.push({ total: at(seenQuantile(turnsLeft, 0.5)), low: at(seenQuantile(turnsLeft, 0.25)), high: at(seenQuantile(turnsLeft, 0.75)), weight: 0.5 });
    }
  }

  const steps = run.steps;
  let planWeight = 0;
  if (steps !== null && steps.total >= 2 && steps.done >= 1 && elapsed > 0) {
    const share = steps.done / steps.total;
    if (steps.done >= steps.total) {
      parts.push({ total: elapsed * 1.05, low: elapsed, high: elapsed * 1.2, weight: 2 });
      planWeight = 2;
    } else {
      const total = elapsed / share;
      const spread = 1 + 1 / Math.sqrt(steps.done + 1);
      planWeight = 1.5 * share;
      parts.push({ total, low: total / spread, high: total * spread, weight: planWeight });
    }
    if (share >= 0.8) overrunning = false;
  }

  if (parts.length === 0) return null;
  const weight = parts.reduce((sum, part) => sum + part.weight, 0);
  const blend = (field: "total" | "low" | "high"): number => Math.exp(parts.reduce((sum, part) => sum + part.weight * Math.log(Math.max(1, part[field])), 0) / weight);
  const total = Math.max(blend("total"), elapsed + 5_000);
  const low = Math.min(total, Math.max(blend("low"), elapsed));
  const high = Math.max(blend("high"), total);
  const runs = prior?.durations.length ?? 0;
  const confident = !overrunning && high / Math.max(low, 1) <= 2.2 && (planWeight >= 1 || runs >= 15);
  return {
    from: run.from,
    totalMs: roundMs(total),
    lowMs: roundMs(low),
    highMs: roundMs(high),
    typicalMs: roundMs(prior === null ? total : quantile(prior.durations, 0.5) * bias),
    runs,
    confidence: confident ? "confident" : "rough",
    overrunning,
    ...(steps === null ? {} : { steps: { done: Math.min(steps.done, steps.total), total: steps.total } }),
  };
}
