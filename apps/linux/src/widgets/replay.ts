// Replays the widget gate (`gate.ts`) over the real automatic asks: every `widget/widget.requested` in the
// atomic-agents journal (it holds the full `draft`) joined by `requestId` with its host outcome in
// `<home>/bench/widget/shadow.jsonl` and the agent's `widget/widget.ready`. Prints how many asks would still
// run under the limits in force (`components.widget.autoAsk`, else the defaults) and by which signal, what
// becomes of the shown, timeout and none outcomes, when the timed-out asks really got their answer, and the
// gate on Isaac's 🎯 labels. `--until <ISO time>` keeps only host logs up to then (the pragmatic review's
// snapshot was 2026-11-18T14:44:45.269Z: 1,112 live asks). Read-only.
//
//   bun src/widgets/replay.ts [--until <ISO time>] [<atomic-agents home>]
//   (home default: ATOMIC_AGENTS_HOME, else ~/.config/relay/atomic-agents)

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { defaultAtomicAgentsHome, readConfig } from "./bus";
import { gateCounts, WIDGET_SIGNALS, widgetGate, type GateLimits, type GateResult } from "./gate";
import { autoAskSettings } from "./service";

const Requested = z.object({
  type: z.literal("widget/widget.requested"),
  at: z.string(),
  data: z.object({ requestId: z.string(), draft: z.string() }),
});
const Ready = z.object({
  type: z.literal("widget/widget.ready"),
  at: z.string(),
  data: z.object({ requestId: z.string(), kind: z.string() }),
});
/** A `shadow.jsonl` line (`service.ts` writes it). */
const Logged = z.object({
  at: z.string(),
  mode: z.string(),
  kind: z.string(),
  requestId: z.string(),
  shown: z.boolean(),
});
/** A `training.jsonl` line (`service.ts` `label`). */
const Labeled = z.object({
  label: z.string(),
  draft: z.string(),
  suggestion: z.object({ kind: z.string() }).optional(),
});

/** Every line of `file` that `schema` reads; none when the file is missing. */
function lines<T>(file: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const parsed = schema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

/** Nearest-rank percentile of sorted `values`. */
const percentile = (values: readonly number[], p: number): number =>
  values[Math.max(0, Math.ceil((p / 100) * values.length) - 1)] ?? NaN;

const excerpt = (text: string): string => text.replace(/\s+/g, " ").slice(0, 110);
const why = (gate: GateResult, limits: GateLimits): string =>
  (gate.eligible ? `runs on ${gate.signals.join(", ")}` : "skipped") +
  ` (${gateCounts(gate, limits)}${gate.beforeAfter ? ", before/after wording" : ""})`;

/** The replay report, one string per line. */
function report(home: string, until: string | undefined): string[] {
  const out: string[] = [];
  const { limits, waitMs } = autoAskSettings(readConfig(home));
  const journal = join(home, "events.ndjson");
  const requested = new Map(
    lines(journal, Requested).map((event) => [
      event.data.requestId,
      { draft: event.data.draft, at: Date.parse(event.at) },
    ]),
  );
  const ready = new Map<string, { at: number; kind: string }>();
  for (const event of lines(journal, Ready))
    if (!ready.has(event.data.requestId))
      ready.set(event.data.requestId, { at: Date.parse(event.at), kind: event.data.kind });
  const shadow = lines(join(home, "bench", "widget", "shadow.jsonl"), Logged).filter(
    (row) => until === undefined || row.at <= until,
  );
  const live = shadow.filter((row) => row.mode === "live");
  const joined = live.flatMap((row) => {
    const request = requested.get(row.requestId);
    return request === undefined ? [] : [{ row, request, gate: widgetGate(request.draft, limits) }];
  });
  const run = joined.filter((ask) => ask.gate.eligible);

  out.push(
    `limits: ${WIDGET_SIGNALS.map((signal) => `${signal} ${String(limits[signal])}`).join(", ")}; wait ${String(waitMs)} ms`,
  );
  out.push(
    `host logs: ${String(shadow.length)} (${String(live.length)} live); live asks with their request in the journal: ${String(joined.length)}`,
  );
  out.push(
    `live asks before: ${String(joined.length)}; would run after: ${String(run.length)}; skipped: ${String(joined.length - run.length)}`,
  );
  for (const signal of WIDGET_SIGNALS)
    out.push(
      `  ${signal.padEnd(8)} ${String(run.filter((ask) => ask.gate.signals.includes(signal)).length)}  (alone ${String(run.filter((ask) => ask.gate.signals.length === 1 && ask.gate.signals[0] === signal).length)})`,
    );

  const byKind = (kind: string) => joined.filter((ask) => ask.row.kind === kind);
  for (const kind of ["openui", "none", "timeout"]) {
    const all = byKind(kind);
    out.push(
      `${kind}: ${String(all.length)}, would still run ${String(all.filter((ask) => ask.gate.eligible).length)}, skipped ${String(all.filter((ask) => !ask.gate.eligible).length)}`,
    );
  }

  const shown = joined.filter((ask) => ask.row.shown);
  out.push(
    `\nshown: ${String(shown.length)}, would still run ${String(shown.filter((ask) => ask.gate.eligible).length)}`,
  );
  for (const ask of shown)
    out.push(`  ${ask.row.at} ${why(ask.gate, limits)}\n    ${excerpt(ask.request.draft)}`);

  const timeouts = byKind("timeout");
  const late = timeouts.flatMap((ask) => {
    const answer = ready.get(ask.row.requestId);
    return answer === undefined
      ? []
      : [{ ms: answer.at - ask.request.at, kind: answer.kind, eligible: ask.gate.eligible }];
  });
  const sorted = late.map((answer) => answer.ms).sort((a, b) => a - b);
  out.push(
    `\ntimeouts: ${String(timeouts.length)}; the agent answered later for ${String(late.length)}, never for ${String(timeouts.length - late.length)}`,
  );
  if (sorted.length > 0) {
    out.push(
      `  requested -> ready ms: min ${String(sorted[0])}, p50 ${String(percentile(sorted, 50))}, p90 ${String(percentile(sorted, 90))}, p95 ${String(percentile(sorted, 95))}, max ${String(sorted.at(-1))}`,
    );
    const bins: [number, number][] = [
      [3_000, 4_000],
      [4_000, 6_000],
      [6_000, 10_000],
      [10_000, 20_000],
      [20_000, Infinity],
    ];
    out.push(
      `  ${bins.map(([from, to]) => `${String(from / 1000)}-${to === Infinity ? "" : String(to / 1000)} s: ${String(sorted.filter((ms) => ms >= from && ms < to).length)}`).join(", ")}`,
    );
    out.push(
      `  answered within the ${String(waitMs)} ms wait: ${String(sorted.filter((ms) => ms <= waitMs).length)}`,
    );
  }
  for (const kind of new Set(late.map((answer) => answer.kind))) {
    const answers = late.filter((answer) => answer.kind === kind);
    out.push(
      `  late ${kind}: ${String(answers.length)}, would still be asked ${String(answers.filter((answer) => answer.eligible).length)}`,
    );
  }

  const training = lines(join(home, "bench", "widget", "training.jsonl"), Labeled);
  out.push(`\n🎯 labels: ${String(training.length)}`);
  for (const label of training)
    out.push(
      `  ${label.label} (suggestion ${label.suggestion?.kind ?? "none"}): ${why(widgetGate(label.draft, limits), limits)}\n    ${excerpt(label.draft)}`,
    );
  return out;
}

const { values, positionals } = parseArgs({
  options: { until: { type: "string" } },
  allowPositionals: true,
});
process.stdout.write(
  `${report(positionals[0] ?? defaultAtomicAgentsHome(), values.until).join("\n")}\n`,
);
