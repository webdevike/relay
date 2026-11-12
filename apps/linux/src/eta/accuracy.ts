// How good the estimates are: replaying held-out past runs through the estimator (`backtest`), and
// what live runs logged when they finished (`CalibrationRecord`, see calibration.ts). Both report the
// same numbers: the median error of the predicted total at points through each run, and how often
// the real length fell inside the predicted middle-half range. The same replay decides when a badge
// may be solid (`ConfidenceTable`).
import { estimateRun, quantile, RunIndex, stageOf, type Trust } from "./estimate";
import type { PlanSteps, RunAgent, RunKey, RunRecord } from "./runs";

export const CHECKPOINTS = [0.1, 0.25, 0.5, 0.75] as const;

/** The held-out share of finished runs, latest first. */
export const HOLDOUT = 0.2;

export interface Prediction {
  /** Elapsed time when it was made, ms. */
  readonly elapsedMs: number;
  readonly totalMs: number;
  readonly lowMs: number;
  readonly highMs: number;
  readonly confident: boolean;
}

/** One finished live run as logged: what was predicted along the way, and how long it really took. */
export interface CalibrationRecord extends RunKey {
  readonly id: string;
  readonly title: string;
  readonly from: number;
  readonly actualMs: number;
  readonly predictions: readonly Prediction[];
}

export interface CheckpointStats {
  /** Share of the run elapsed when the prediction was read. */
  readonly at: number;
  readonly n: number;
  /** Median of |predicted total - actual| / actual. */
  readonly medianError: number;
  /** Share of runs whose actual length fell inside the predicted range. */
  readonly inRange: number;
  /** Median error of the confident and the rough predictions, when there were any. */
  readonly confidentError: number | null;
  readonly roughError: number | null;
  readonly confidentShare: number;
}

export interface Accuracy {
  readonly runs: number;
  readonly checkpoints: readonly CheckpointStats[];
}

const finishedRun = (run: RunRecord): boolean => run.outcome === "done" && run.durationMs >= 5000;

/** Splits finished runs by time: everything before the latest `HOLDOUT` share trains, the rest tests. */
export function holdout(runs: readonly RunRecord[]): { train: RunRecord[]; test: RunRecord[]; splitAt: number | null } {
  const finished = runs.filter(finishedRun);
  if (finished.length < 10) return { train: [...runs], test: [], splitAt: null };
  const splitAt = finished[Math.floor(finished.length * (1 - HOLDOUT))]!.startedAt;
  return { train: runs.filter((run) => run.startedAt < splitAt), test: runs.filter((run) => run.startedAt >= splitAt), splitAt };
}

/** Plan steps and turns a run had reached `seconds` in. */
function stateAt(run: RunRecord, seconds: number): { turns: number; steps: PlanSteps | null } {
  let turns = 0;
  for (const at of run.turnAt) if (at <= seconds) turns += 1;
  let steps: PlanSteps | null = null;
  for (const [at, done, total] of run.stepsAt) if (at <= seconds) steps = { done, total };
  return { turns, steps };
}

/** The estimate a past run would have shown `share` of the way through. */
export function predictAt(index: RunIndex, run: RunRecord, share: number, bias?: number, trust?: Trust): Prediction | null {
  const elapsedMs = run.durationMs * share;
  const state = stateAt(run, elapsedMs / 1000);
  const eta = estimateRun(index, { key: run, from: run.startedAt, ...state, ...(run.limitMs === undefined ? {} : { limitMs: run.limitMs }) }, run.startedAt + elapsedMs, {
    ...(bias === undefined ? {} : { bias }),
    ...(trust === undefined ? {} : { trust }),
  });
  return eta === null ? null : { elapsedMs, totalMs: eta.totalMs, lowMs: eta.lowMs, highMs: eta.highMs, confident: eta.confidence === "confident" };
}

/** The prediction made closest to `share` of the actual length (within a fifth of it). */
function nearest(record: CalibrationRecord, share: number): Prediction | null {
  const target = record.actualMs * share;
  let best: Prediction | null = null;
  for (const prediction of record.predictions) {
    if (best === null || Math.abs(prediction.elapsedMs - target) < Math.abs(best.elapsedMs - target)) best = prediction;
  }
  return best !== null && Math.abs(best.elapsedMs - target) <= record.actualMs * 0.2 ? best : null;
}

const relativeError = (prediction: Prediction, actualMs: number): number => Math.abs(prediction.totalMs - actualMs) / actualMs;
const median = (list: readonly number[]): number | null => (list.length === 0 ? null : quantile([...list].sort((a, b) => a - b), 0.5));

function summarize(at: number, rows: readonly { prediction: Prediction; actualMs: number }[]): CheckpointStats {
  const confident = rows.filter((row) => row.prediction.confident).map((row) => relativeError(row.prediction, row.actualMs));
  const rough = rows.filter((row) => !row.prediction.confident).map((row) => relativeError(row.prediction, row.actualMs));
  return {
    at,
    n: rows.length,
    medianError: median(rows.map((row) => relativeError(row.prediction, row.actualMs))) ?? Number.NaN,
    inRange: rows.length === 0 ? Number.NaN : rows.filter((row) => row.actualMs >= row.prediction.lowMs && row.actualMs <= row.prediction.highMs).length / rows.length,
    confidentError: median(confident),
    roughError: median(rough),
    confidentShare: rows.length === 0 ? 0 : confident.length / rows.length,
  };
}

/** What a predictor would have shown for a past run `share` of the way through. */
export type Predictor = (run: RunRecord, share: number) => Prediction | null;

/** The estimator over `index`, with an optional calibration bias per run and a trust table. */
export const estimatorPredictor =
  (index: RunIndex, bias?: (run: RunRecord) => number, trust?: Trust): Predictor =>
  (run, share) =>
    predictAt(index, run, share, bias?.(run), trust);

/**
 * The plain guess to beat: similar runs (same agent) usually take their median, so the total is that
 * median, or a little more than the elapsed time once the run is past it.
 */
export function medianPredictor(index: RunIndex): Predictor {
  return (run, share) => {
    const durations = index.bucketsFor(run).find((bucket) => bucket.level === `agent=${run.agent}`)?.durations ?? [];
    if (durations.length === 0) return null;
    const elapsedMs = run.durationMs * share;
    const totalMs = Math.max(quantile(durations, 0.5), elapsedMs + 5000);
    return { elapsedMs, totalMs, lowMs: Math.max(quantile(durations, 0.25), elapsedMs), highMs: Math.max(quantile(durations, 0.75), totalMs), confident: false };
  };
}

/** Replays finished `test` runs through `predict` at each checkpoint. */
export function backtest(test: readonly RunRecord[], predict: Predictor): Accuracy {
  const finished = test.filter(finishedRun);
  return {
    runs: finished.length,
    checkpoints: CHECKPOINTS.map((at) =>
      summarize(
        at,
        finished.flatMap((run) => {
          const prediction = predict(run, at);
          return prediction === null ? [] : [{ prediction, actualMs: run.durationMs }];
        }),
      ),
    ),
  };
}

/** The same numbers for what live runs logged. */
export function calibrationAccuracy(records: readonly CalibrationRecord[]): Accuracy {
  return {
    runs: records.length,
    checkpoints: CHECKPOINTS.map((at) =>
      summarize(
        at,
        records.flatMap((record) => {
          const prediction = nearest(record, at);
          return prediction === null ? [] : [{ prediction, actualMs: record.actualMs }];
        }),
      ),
    ),
  };
}

/** A badge is solid only where replayed estimates were off by less than this (median). */
export const TRUST_ERROR = 0.25;
/** Replayed estimates a cell needs before it can be trusted. */
export const TRUST_MIN = 20;
/** Points through each replayed run, as shares of its length. */
const TRUST_GRID = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95] as const;
/** Elapsed over a typical run's length, where the no-plan cells split. */
const STAGE_STEPS = [0.25, 0.5, 1, 2] as const;
/** A cell: agent, plan or none, and the run's stage (`stageOf`): fifths of the plan, else `STAGE_STEPS`. */
const cellId = (agent: RunAgent, planned: boolean, stage: number): string =>
  `${agent}·${planned ? `plan·${Math.min(4, Math.max(0, Math.floor(stage * 5)))}` : `-·${STAGE_STEPS.filter((step) => stage >= step).length}`}`;

export interface TrustCell {
  readonly n: number;
  readonly medianError: number;
}

/**
 * When a badge may be solid, learned by replay: the runs before the latest fifth build an index, the
 * latest fifth is replayed through it at points along each run, and every estimate's error lands in
 * a cell by agent, plan or none, and the stage a live badge can see (`stageOf`). A cell is trusted
 * when it has `TRUST_MIN` estimates with a median error under `TRUST_ERROR`; everything else draws
 * striped.
 */
export class ConfidenceTable {
  static readonly EMPTY = new ConfidenceTable({});

  constructor(readonly cells: Readonly<Record<string, TrustCell>>) {}

  static build(runs: readonly RunRecord[]): ConfidenceTable {
    const { train, test } = holdout(runs);
    const index = new RunIndex(train);
    const errors: Record<string, number[]> = {};
    for (const run of test) {
      if (!finishedRun(run)) continue;
      for (const share of TRUST_GRID) {
        const elapsedMs = run.durationMs * share;
        const state = stateAt(run, elapsedMs / 1000);
        const eta = estimateRun(index, { key: run, from: run.startedAt, ...state, ...(run.limitMs === undefined ? {} : { limitMs: run.limitMs }) }, run.startedAt + elapsedMs);
        if (eta === null) continue;
        const id = cellId(run.agent, state.steps !== null, stageOf(elapsedMs, eta.typicalMs, state.steps));
        (errors[id] ??= []).push(Math.abs(eta.totalMs - run.durationMs) / run.durationMs);
      }
    }
    const cells: Record<string, TrustCell> = {};
    for (const [id, list] of Object.entries(errors)) cells[id] = { n: list.length, medianError: median(list) ?? Number.NaN };
    return new ConfidenceTable(cells);
  }

  readonly trust: Trust = (key, planned, stage) => {
    const cell = this.cells[cellId(key.agent, planned, stage)];
    return cell !== undefined && cell.n >= TRUST_MIN && cell.medianError < TRUST_ERROR;
  };
}

/** Logged runs needed before their bias is applied. */
export const MIN_BIAS_RUNS = 5;

/**
 * How far off the first prediction of runs like this one was, as actual over predicted (median of
 * the latest 50 with the same agent and kind). 1 until there are enough.
 */
export function biasFor(records: readonly CalibrationRecord[], key: RunKey): number {
  const ratios: number[] = [];
  for (let i = records.length - 1; i >= 0 && ratios.length < 50; i -= 1) {
    const record = records[i]!;
    const first = record.predictions[0];
    if (record.agent !== key.agent || record.kind !== key.kind || first === undefined) continue;
    ratios.push(record.actualMs / first.totalMs);
  }
  if (ratios.length < MIN_BIAS_RUNS) return 1;
  return quantile(ratios.sort((a, b) => a - b), 0.5);
}
