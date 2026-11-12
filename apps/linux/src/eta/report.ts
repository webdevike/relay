// `relay-host eta`: how good the estimates are. Replays the latest fifth of finished runs against an
// index of the runs before them (the estimator next to the plain "similar runs take their median"
// guess), with confidence learned only from those earlier runs, and summarizes what live runs logged
// in the calibration file.
import { backtest, calibrationAccuracy, ConfidenceTable, estimatorPredictor, holdout, medianPredictor, TRUST_ERROR, type Accuracy } from "./accuracy";
import type { CalibrationLog } from "./calibration";
import { RunIndex } from "./estimate";
import type { RunHistory } from "./history";
import type { RunAgent, RunRecord } from "./runs";

export interface EtaReport {
  readonly runs: number;
  /** Start of the held-out runs. */
  readonly splitAt: number | null;
  readonly heldOut: readonly { agent: RunAgent | "plan"; estimator: Accuracy; median: Accuracy }[];
  /** Held-out helper runs by who ran them (`helper-code`, `scout`...), the estimator only. */
  readonly helperRoles: readonly { role: string; estimator: Accuracy }[];
  readonly live: Accuracy;
}

export function etaReport(runs: readonly RunRecord[], calibration: CalibrationLog): EtaReport {
  const { train, test, splitAt } = holdout(runs);
  const index = new RunIndex(train);
  const predict = estimatorPredictor(index, undefined, ConfidenceTable.build(train).trust);
  const groups: { agent: RunAgent | "plan"; runs: RunRecord[] }[] = [
    { agent: "task", runs: test.filter((run) => run.agent === "task") },
    { agent: "helper", runs: test.filter((run) => run.agent === "helper") },
    { agent: "chat", runs: test.filter((run) => run.agent === "chat") },
    { agent: "plan", runs: test.filter((run) => run.stepsAt.length > 0) },
  ];
  const roles: Record<string, RunRecord[]> = {};
  for (const run of test) if (run.agent === "helper") (roles[run.role ?? "unknown"] ??= []).push(run);
  return {
    runs: runs.length,
    splitAt,
    heldOut: groups.map((group) => ({ agent: group.agent, estimator: backtest(group.runs, predict), median: backtest(group.runs, medianPredictor(index)) })),
    helperRoles: Object.entries(roles)
      .map(([role, list]) => ({ role, estimator: backtest(list, predict) }))
      .filter((row) => row.estimator.runs >= 10)
      .sort((a, b) => b.estimator.runs - a.estimator.runs),
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
  out.push(`Confident (solid) only where replays before the held-out runs erred under ${pct(TRUST_ERROR).trim()}.`);
  for (const group of report.heldOut) {
    out.push("", `Held-out ${group.agent === "plan" ? "runs with a plan" : `${group.agent} runs`}: ${group.estimator.runs}`, ...table(group.estimator, group.median));
  }
  for (const row of report.helperRoles) out.push("", `Held-out helper runs by ${row.role}: ${row.estimator.runs}`, ...table(row.estimator));
  out.push("", `Live runs logged: ${report.live.runs}`, ...table(report.live));
  return out.join("\n");
}

/** Loads history (from its cache, reading only what changed) and builds the report. */
export async function runEtaReport(history: RunHistory, calibration: CalibrationLog): Promise<EtaReport> {
  await history.refresh(Date.now());
  return etaReport(history.runs(), calibration);
}
