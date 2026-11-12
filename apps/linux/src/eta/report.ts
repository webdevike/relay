// `relay-host eta`: how good the estimates are. Replays the latest fifth of finished runs against an
// index of the runs before them (the estimator next to the plain "similar runs take their median"
// guess), and summarizes what live runs logged in the calibration file.
import { backtest, calibrationAccuracy, estimatorPredictor, medianPredictor, type Accuracy } from "./accuracy";
import type { CalibrationLog } from "./calibration";
import { RunIndex } from "./estimate";
import type { RunHistory } from "./history";
import type { RunAgent, RunRecord } from "./runs";

/** The held-out share of finished runs, latest first. */
export const HOLDOUT = 0.2;

export interface EtaReport {
  readonly runs: number;
  /** Start of the held-out runs. */
  readonly splitAt: number | null;
  readonly heldOut: readonly { agent: RunAgent | "plan"; estimator: Accuracy; median: Accuracy }[];
  readonly live: Accuracy;
}

/** Splits finished runs by time: everything before the latest `HOLDOUT` share trains, the rest tests. */
export function holdout(runs: readonly RunRecord[]): { train: RunRecord[]; test: RunRecord[]; splitAt: number | null } {
  const finished = runs.filter((run) => run.outcome === "done" && run.durationMs >= 5000);
  if (finished.length < 10) return { train: [...runs], test: [], splitAt: null };
  const splitAt = finished[Math.floor(finished.length * (1 - HOLDOUT))]!.startedAt;
  return { train: runs.filter((run) => run.startedAt < splitAt), test: runs.filter((run) => run.startedAt >= splitAt), splitAt };
}

export function etaReport(runs: readonly RunRecord[], calibration: CalibrationLog): EtaReport {
  const { train, test, splitAt } = holdout(runs);
  const index = new RunIndex(train);
  const groups: { agent: RunAgent | "plan"; runs: RunRecord[] }[] = [
    { agent: "task", runs: test.filter((run) => run.agent === "task") },
    { agent: "helper", runs: test.filter((run) => run.agent === "helper") },
    { agent: "chat", runs: test.filter((run) => run.agent === "chat") },
    { agent: "plan", runs: test.filter((run) => run.stepsAt.length > 0) },
  ];
  return {
    runs: runs.length,
    splitAt,
    heldOut: groups.map((group) => ({ agent: group.agent, estimator: backtest(group.runs, estimatorPredictor(index)), median: backtest(group.runs, medianPredictor(index)) })),
    live: calibrationAccuracy(calibration.records()),
  };
}

const pct = (value: number | null): string => (value === null || Number.isNaN(value) ? "  -" : `${Math.round(value * 100)}%`.padStart(4));

function table(accuracy: Accuracy, against?: Accuracy): string[] {
  const lines = ["  through   n   error  in range  confident (error)" + (against === undefined ? "" : "  median guess error")];
  accuracy.checkpoints.forEach((row, i) => {
    const base = against?.checkpoints[i];
    lines.push(
      `  ${pct(row.at)}  ${String(row.n).padStart(5)}   ${pct(row.medianError)}     ${pct(row.inRange)}      ${pct(row.confidentShare)} (${pct(row.confidentError)})` +
        (base === undefined ? "" : `           ${pct(base.medianError)}`),
    );
  });
  return lines;
}

export function formatReport(report: EtaReport): string {
  const out = [`${report.runs} past runs; held out from ${report.splitAt === null ? "none" : new Date(report.splitAt).toISOString()}`];
  out.push("Error = median |predicted total - actual| / actual; in range = actual inside the predicted middle half.");
  for (const group of report.heldOut) {
    out.push("", `Held-out ${group.agent === "plan" ? "runs with a plan" : `${group.agent} runs`}: ${group.estimator.runs}`, ...table(group.estimator, group.median));
  }
  out.push("", `Live runs logged: ${report.live.runs}`, ...table(report.live));
  return out.join("\n");
}

/** Loads history (from its cache, reading only what changed) and builds the report. */
export async function runEtaReport(history: RunHistory, calibration: CalibrationLog): Promise<EtaReport> {
  await history.refresh(Date.now());
  return etaReport(history.runs(), calibration);
}
