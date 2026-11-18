import { Schema } from "effect";

/**
 * The pure half of the `eta-report` agent: what `agent-session.ts estimates --json` answers, reduced to the numbers
 * Nova quotes ETAs by, compared with last week's, and laid out as the thread message and the `estimates.md` section.
 * No I/O here; `agent.ts` runs the commands and files around it.
 */

/** One finished run with an estimate, as `estimates --json` lists it (`ratio` is actual / estimate). */
export const EstimateRun = Schema.Struct({ kind: Schema.String, ratio: Schema.Finite });
export type EstimateRun = typeof EstimateRun.Type;

/** `estimates --owner <id> --since <d> --json`: the runs (the tool lists more fields per run; only these matter). */
export const EstimatesJson = Schema.Struct({ runs: Schema.Array(EstimateRun) });

/** One row of `estimates --baseline --json`. */
export const BaselineRow = Schema.Struct({
  group: Schema.String,
  bucket: Schema.String,
  n: Schema.Int,
  medianMin: Schema.Finite,
});
export const BaselineJson = Schema.Array(BaselineRow);

export const WorstKind = Schema.Struct({
  kind: Schema.String,
  n: Schema.Int,
  medianRatio: Schema.Finite,
});
export type WorstKind = typeof WorstKind.Type;

/** A week's numbers; the ratio fields are absent when no run had an estimate. */
export const Week = Schema.Struct({
  n: Schema.Int,
  medianRatio: Schema.optionalKey(Schema.Finite),
  /** Share (0-1) of runs whose ratio is within 1 +- 0.5. */
  within50: Schema.optionalKey(Schema.Finite),
  worstKind: Schema.optionalKey(WorstKind),
});
export type Week = typeof Week.Type;

/** What the agent keeps between runs: last week's numbers and when they were taken. */
export const Saved = Schema.Struct({ at: Schema.String, week: Week });
export type Saved = typeof Saved.Type;

export const Change = Schema.Struct({
  /** This week's median ratio minus last week's. */
  medianRatio: Schema.Finite,
  /** This week's within-50% share minus last week's, in percentage points. */
  within50Points: Schema.Finite,
});
export type Change = typeof Change.Type;

export const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Median ratio, share within 50% of the estimate and the kind whose median is furthest from 1 (in either direction, by ratio: 0.5 and 2 are equally far). */
export const summarize = (runs: ReadonlyArray<EstimateRun>): Week => {
  if (runs.length === 0) return { n: 0 };
  const kinds = new Map<string, Array<number>>();
  for (const run of runs) kinds.set(run.kind, [...(kinds.get(run.kind) ?? []), run.ratio]);
  const distance = (ratio: number) => Math.abs(Math.log(Math.max(ratio, 1e-6)));
  const worst = [...kinds]
    .map(([kind, ratios]): WorstKind => ({ kind, n: ratios.length, medianRatio: median(ratios) }))
    .sort(
      (a, b) =>
        distance(b.medianRatio) - distance(a.medianRatio) ||
        b.n - a.n ||
        a.kind.localeCompare(b.kind),
    )[0]!;
  return {
    n: runs.length,
    medianRatio: median(runs.map((run) => run.ratio)),
    within50: runs.filter((run) => Math.abs(run.ratio - 1) <= 0.5).length / runs.length,
    worstKind: worst,
  };
};

/** The change against last week; absent unless both weeks had runs with an estimate. */
export const compare = (now: Week, before: Week | undefined): Change | undefined =>
  before === undefined ||
  now.medianRatio === undefined ||
  now.within50 === undefined ||
  before.medianRatio === undefined ||
  before.within50 === undefined
    ? undefined
    : {
        medianRatio: now.medianRatio - before.medianRatio,
        within50Points: (now.within50 - before.within50) * 100,
      };

/** The owner's finished-run baseline (`--baseline`): how many runs and their median wall time in minutes. */
export const baselineOf = (
  rows: typeof BaselineJson.Type,
  owner: string,
): { readonly n: number; readonly medianMinutes: number } | undefined => {
  const row = rows.find((candidate) => candidate.group === "owner" && candidate.bucket === owner);
  return row === undefined ? undefined : { n: row.n, medianMinutes: row.medianMin };
};

const ratio = (value: number) => value.toFixed(2);
const signed = (value: number, digits: number) =>
  `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(digits)}`;
const percent = (share: number) => `${Math.round(share * 100)}%`;

/** `actual / estimate` below 1 means the run beat its estimate (the quote was too long). */
export const verdict = (medianRatio: number): string =>
  medianRatio < 0.85
    ? "quotes ran long"
    : medianRatio > 1.15
      ? "quotes ran short"
      : "quotes on target";

export interface Report {
  readonly week: Week;
  readonly change: Change | undefined;
  readonly baseline: { readonly n: number; readonly medianMinutes: number } | undefined;
  /** ISO date the window ends on. */
  readonly date: string;
  readonly since: string;
  readonly owner: string;
}

const baselineLine = (baseline: Report["baseline"], owner: string) =>
  baseline === undefined
    ? []
    : [
        `Baseline: ${baseline.n} finished ${owner} runs in 30 days, median ${baseline.medianMinutes.toFixed(1)}m.`,
      ];

/** The 2-3 line plain-text message for the owner's thread (without the `[eta-report] ` prefix). */
export const message = ({ week, change, baseline, since, owner }: Report): string => {
  if (week.medianRatio === undefined || week.within50 === undefined) {
    return [
      `No finished ${owner} runs with an estimate in the last ${since} (start them with --estimate <dur>).`,
      ...baselineLine(baseline, owner),
    ].join("\n");
  }
  const head = `${week.n} finished runs with an estimate: median actual/estimate ${ratio(week.medianRatio)} (${verdict(week.medianRatio)}), ${percent(week.within50)} within ±50%.`;
  const worst =
    week.worstKind === undefined
      ? undefined
      : `Worst kind: ${week.worstKind.kind}, median ${ratio(week.worstKind.medianRatio)} (n=${week.worstKind.n}).`;
  const moved =
    change === undefined
      ? "No last week to compare with."
      : `Vs last week: median ${signed(change.medianRatio, 2)}, within ±50% ${signed(change.within50Points, 0)} pts.`;
  return [head, [worst, moved].filter((part) => part !== undefined).join(" ")].join("\n");
};

/** The `## Last week` section of `estimates.md` (heading included, trailing newline). */
export const section = ({ week, change, baseline, date, since, owner }: Report): string => {
  const lines = [LAST_WEEK, ""];
  if (week.medianRatio === undefined || week.within50 === undefined) {
    lines.push(
      `As of ${date}: no finished ${owner} runs with an estimate in the last ${since}. Pass \`--estimate <dur>\` on every \`start\`.`,
    );
  } else {
    lines.push(
      `As of ${date} (last ${since}, ${owner} runs; ratio is actual / estimate, below 1 means the quote was too long):`,
      "",
      `- Finished runs with an estimate: ${week.n}`,
      `- Median ratio: ${ratio(week.medianRatio)} (${verdict(week.medianRatio)})${change === undefined ? "" : `, ${signed(change.medianRatio, 2)} vs the week before`}`,
      `- Within ±50% of the estimate: ${percent(week.within50)}${change === undefined ? "" : `, ${signed(change.within50Points, 0)} pts vs the week before`}`,
    );
    if (week.worstKind !== undefined)
      lines.push(
        `- Worst job kind: ${week.worstKind.kind}, median ratio ${ratio(week.worstKind.medianRatio)} (n=${week.worstKind.n})`,
      );
  }
  lines.push(
    ...baselineLine(baseline, owner).map((line) => `- ${line}`),
    "",
    "Written by the `eta-report` atomic agent (Wednesdays 09:00).",
  );
  return `${lines.join("\n")}\n`;
};

export const LAST_WEEK = "## Last week";

/** `markdown` with its `## Last week` section replaced by `body`; absent, the section goes before the first other `## ` heading (else at the end). */
export const withSection = (markdown: string, body: string): string => {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === LAST_WEEK);
  const nextHeading = (from: number) => {
    const found = lines.findIndex((line, index) => index >= from && line.startsWith("## "));
    return found === -1 ? lines.length : found;
  };
  const bodyLines = body.replace(/\n+$/, "").split("\n");
  if (start === -1) {
    const at = nextHeading(0);
    if (at === lines.length) return `${markdown.replace(/\n*$/, "\n")}\n${bodyLines.join("\n")}\n`;
    return [...lines.slice(0, at), ...bodyLines, "", ...lines.slice(at)].join("\n");
  }
  const end = nextHeading(start + 1);
  return [
    ...lines.slice(0, start),
    ...bodyLines,
    ...(end === lines.length ? [""] : ["", ...lines.slice(end)]),
  ].join("\n");
};
