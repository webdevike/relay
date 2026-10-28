#!/usr/bin/env bun
// Offline eval of the agent-emitted reply-chip rule on real Nova and Astra replies.
//
//   bun evals/reply-chips/run.ts [--models opus,haiku] [--date YYYY-MM-DD] [--concurrency 4] [--score-only]
//
// For each dataset item it asks a model, primed with the rule text, which `[[replies: ...]]` line it
// would append to that reply (or NONE), parses it with the host's own `splitReplies`, has Sonnet judge
// the chips on true positives, and writes `results-<date>.md`. Raw model and judge outputs are cached
// in `outputs-<date>.jsonl`; rerunning only calls the models for rows that are missing there.

import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_REPLIES,
  MAX_REPLY_CHARS,
  splitReplies,
} from "../../apps/linux/src/assistant/replies.ts";

const HERE = import.meta.dir;

/** The prime rule, verbatim from the reply-chips spec ("Rules" section). */
const RULE = `When a message ends on a question Isaac can answer in a few words from a small set of clear answers
(yes or no, which of the options just named, a time or day), add one last line
\`[[replies: <answer> | <answer>]]\` with two to four answers in his words, each at most 24 characters.
Relay shows them as tap-to-reply buttons under the bubble and sends the one he taps as his message.
Write each the way he would say it; on a yes to anything hard to undo, name the action
("Yes, deploy it", not "Yes"). Keep the question in words. Skip it for open questions (what should it
say, what do you think, anything else?), when there is no question, and on voice-call turns.`;

/** A candidate rewording of `RULE` that targets the failures of the 2026-10-28 run (see README.md). */
const RULE_PROPOSED = `When a message ends on a question to Isaac that he can answer in a few words from a small set of clear
answers (yes or no, which of the options just named, a time or day), add one last line
\`[[replies: <answer> | <answer>]]\` with two to four answers in his words, each at most 24 characters
(about four words; a longer one is dropped). Relay shows them as tap-to-reply buttons under the bubble
and sends the one he taps as his message. Write each the way he would say it; on a yes to anything hard
to undo, name the action ("Yes, deploy it", not "Yes"); for a choice, the answer is the option itself
("Keep Workspace", not "Yes, keep it"). Offer only answers the message already gives. Keep the question
in words. Skip it for open questions (what should it say, what do you think, anything else, or something
else?), when he would pick several things at once, when the question is for someone else (inside a draft
or a quote), when there is no question, and on voice-call turns.`;

const RULES: Record<string, string> = { spec: RULE, proposed: RULE_PROPOSED };

const MODELS: Record<string, string> = {
  opus: "anthropic/claude-opus-5-5",
  haiku: "anthropic/claude-haiku-5-5",
};
const JUDGE_MODEL = "anthropic/claude-sonnet-5-5";

type Item = {
  id: string;
  agent: "nova" | "astra";
  kind: string;
  session: string;
  line: number;
  isaac_before: string | null;
  assistant: string;
  isaac_next: string | null;
  should_show: boolean;
  gold: string[];
  note: string;
};

type CacheRow = {
  type: "gen" | "judge";
  model: string;
  id: string;
  raw: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  at: string;
};

type Judged = { quality: number; matched: string[]; why: string };

type Row = {
  item: Item;
  raw: string;
  /** The line the model chose: a `[[replies: ...]]` token, `NONE`, or null when it gave neither. */
  line: string | null;
  /** Labels exactly as emitted, before the parser's filters. */
  rawLabels: string[] | null;
  /** What Relay would show after `splitReplies`. */
  shown: string[] | null;
  formatOk: boolean | null;
  judged: Judged | null;
  coverage: number | null;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const date = arg("date") ?? new Date().toISOString().slice(0, 10);
const modelKeys = (arg("models") ?? "opus,haiku").split(",").map((m) => m.trim());
const concurrency = Number(arg("concurrency") ?? "4");
const scoreOnly = process.argv.includes("--score-only");
/** `spec` is the spec's rule verbatim; any other variant writes its own outputs and results files. */
const variant = arg("variant") ?? "spec";
const rule = RULES[variant];
if (rule === undefined)
  throw new Error(`unknown variant "${variant}"; known: ${Object.keys(RULES).join(", ")}`);
const suffix = variant === "spec" ? date : `${date}-${variant}`;
const outputsPath = join(HERE, `outputs-${suffix}.jsonl`);
const resultsPath = join(HERE, `results-${suffix}.md`);
const handReviewPath = join(HERE, `hand-review-${suffix}.json`);

for (const key of modelKeys) {
  if (!(key in MODELS))
    throw new Error(`unknown model "${key}"; known: ${Object.keys(MODELS).join(", ")}`);
}

const items: Item[] = readFileSync(join(HERE, "dataset.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as Item);

const cache = new Map<string, CacheRow>();
if (existsSync(outputsPath)) {
  for (const l of readFileSync(outputsPath, "utf8").split("\n")) {
    if (l.trim().length === 0) continue;
    const row = JSON.parse(l) as CacheRow;
    cache.set(`${row.type}:${row.model}:${row.id}`, row);
  }
}

// An empty working directory so no AGENTS.md or project context leaks into the prompt.
const sandbox = mkdtempSync(join(tmpdir(), "reply-chips-eval-"));

type Call = { text: string; tokensIn: number; tokensOut: number; costUsd: number };

type OmpMessage = {
  role: string;
  content?: { type: string; text?: string }[];
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
};

/** One hermetic `omp -p` call; returns the final assistant text with its token usage and list-price cost. */
async function omp(model: string, system: string, prompt: string): Promise<Call> {
  const argv = [
    "omp",
    "-p",
    "--mode",
    "json",
    "--model",
    model,
    "--no-tools",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--no-title",
    "--no-lsp",
    "--thinking",
    "off",
    "--cwd",
    sandbox,
    "--system-prompt",
    system,
    prompt,
  ];
  for (let attempt = 1; ; attempt++) {
    const proc = Bun.spawn(argv, { cwd: sandbox, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 180_000);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    let last: OmpMessage | null = null;
    for (const l of out.split("\n")) {
      if (!l.startsWith("{")) continue;
      const event = JSON.parse(l) as { type?: string; message?: OmpMessage };
      if (event.type === "message_end" && event.message?.role === "assistant") last = event.message;
    }
    const text = (last?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();
    if (code === 0 && last !== null && text.length > 0) {
      const usage = last.usage;
      return {
        text,
        tokensIn: (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
        tokensOut: usage?.output ?? 0,
        costUsd: usage?.cost?.total ?? 0,
      };
    }
    if (attempt >= 3) throw new Error(`omp ${model} failed (exit ${code}): ${err.slice(-400)}`);
  }
}

async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  });
  await Promise.all(workers);
  return results;
}

function remember(type: CacheRow["type"], model: string, id: string, call: Call): void {
  const row: CacheRow = {
    type,
    model,
    id,
    raw: call.text,
    tokensIn: call.tokensIn,
    tokensOut: call.tokensOut,
    costUsd: call.costUsd,
    at: new Date().toISOString(),
  };
  cache.set(`${type}:${model}:${id}`, row);
  appendFileSync(outputsPath, JSON.stringify(row) + "\n");
}

// ---------- generation ----------

function genSystem(item: Item): string {
  const name = item.agent === "nova" ? "Nova" : "Astra";
  return [
    `You are ${name}, Isaac's assistant, talking with him in Relay. Below is a reply you already wrote to his last message; you are deciding only its final line. Your instructions include this rule:`,
    "",
    rule,
  ].join("\n");
}

function genPrompt(item: Item): string {
  return [
    "Isaac's message:",
    "<<<",
    item.isaac_before ?? "(none)",
    ">>>",
    "",
    "Your reply:",
    "<<<",
    item.assistant,
    ">>>",
    "",
    "Apply the rule to this reply. Output exactly the last line you would append under the rule, `[[replies: <answer> | <answer>]]`, or the single word NONE if the rule says to skip it. Output nothing else.",
  ].join("\n");
}

const MARKER_LINE = /\[\[replies:[^\]\n]*\]\]/g;

function pickLine(raw: string): string | null {
  const markers = raw.match(MARKER_LINE);
  if (markers !== null) return markers[markers.length - 1]!;
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1]?.replace(/[`*.]/g, "");
  return last === "NONE" ? "NONE" : null;
}

/** The spec's format rule on what the model emitted, before the parser filters anything. */
function formatOk(labels: string[]): boolean {
  const trimmed = labels.map((l) => l.trim().replace(/\s+/g, " "));
  if (trimmed.length < 2 || trimmed.length > MAX_REPLIES) return false;
  if (trimmed.some((l) => l.length === 0 || l.length > MAX_REPLY_CHARS)) return false;
  return new Set(trimmed.map((l) => l.toLowerCase())).size === trimmed.length;
}

// ---------- judge ----------

const JUDGE_SYSTEM = `You grade tap-to-reply chips for a chat app. An assistant ended a message to Isaac with a question; the app shows a few short reply buttons under it, and tapping one sends that label as Isaac's reply, verbatim. You compare a predicted chip set against a hand-labelled gold set for the same message.

Score quality 0, 1 or 2:
- 2: the chips cover the answers Isaac would likely give, each reads naturally as his reply, and any yes to something hard to undo (deploy, merge, send, delete, push) names the action. Tapping any chip would be a correct, unambiguous answer.
- 1: usable, but misses a main option, or a label is awkward, vague, or a bare "Yes" where the action should be named.
- 0: wrong or misleading: a chip answers a different question, contradicts the options offered, or would make the assistant do something Isaac did not choose.

Also list which gold chips are semantically matched by at least one predicted chip (same meaning and same choice; wording may differ).

Reply with JSON only: {"quality": 0|1|2, "matched": ["<gold label>", ...], "why": "<one short sentence>"}`;

function judgePrompt(item: Item, shown: string[]): string {
  return [
    "Assistant message (its ending holds the question):",
    "<<<",
    item.assistant.slice(-1500),
    ">>>",
    "",
    `Gold chips: ${JSON.stringify(item.gold)}`,
    `Predicted chips: ${JSON.stringify(shown)}`,
  ].join("\n");
}

function parseJudge(raw: string): Judged | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m === null) return null;
  try {
    // The judge sometimes leaves a trailing comma before the closing brace.
    const j = JSON.parse(m[0].replace(/,\s*([}\]])/g, "$1")) as Partial<Judged>;
    if (typeof j.quality !== "number" || !Array.isArray(j.matched)) return null;
    return { quality: j.quality, matched: j.matched, why: j.why ?? "" };
  } catch {
    return null;
  }
}

// ---------- run ----------

function evaluate(modelKey: string, item: Item): Row {
  const raw = cache.get(`gen:${modelKey}:${item.id}`)?.raw ?? "";
  const line = pickLine(raw);
  let rawLabels: string[] | null = null;
  let shown: string[] | null = null;
  if (line !== null && line !== "NONE") {
    const body = /\[\[replies:([^\]\n]*)\]\]/.exec(line)?.[1] ?? "";
    rawLabels = body.split("|").map((l) => l.trim());
    shown = splitReplies(`${item.assistant}\n${line}`, false).replies ?? null;
  }
  const judgedRaw = cache.get(`judge:${modelKey}:${item.id}`)?.raw;
  const judged = judgedRaw === undefined ? null : parseJudge(judgedRaw);
  const coverage =
    judged === null
      ? null
      : judged.matched.filter((g) => item.gold.includes(g)).length / item.gold.length;
  return {
    item,
    raw,
    line,
    rawLabels,
    shown,
    formatOk: rawLabels === null ? null : formatOk(rawLabels),
    judged,
    coverage,
  };
}

if (!scoreOnly) {
  for (const key of modelKeys) {
    const todo = items.filter((it) => !cache.has(`gen:${key}:${it.id}`));
    console.log(`${key}: generating ${todo.length} of ${items.length}`);
    await pool(
      todo.map((it) => async () => {
        remember("gen", key, it.id, await omp(MODELS[key]!, genSystem(it), genPrompt(it)));
      }),
      concurrency,
    );
    const toJudge = items
      .map((it) => evaluate(key, it))
      .filter(
        (r) => r.item.should_show && r.shown !== null && !cache.has(`judge:${key}:${r.item.id}`),
      );
    console.log(`${key}: judging ${toJudge.length} true positives with ${JUDGE_MODEL}`);
    await pool(
      toJudge.map((r) => async () => {
        remember(
          "judge",
          key,
          r.item.id,
          await omp(JUDGE_MODEL, JUDGE_SYSTEM, judgePrompt(r.item, r.shown!)),
        );
      }),
      concurrency,
    );
  }
}

// ---------- score + report ----------

type Metrics = {
  n: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  malformed: number;
  precision: number;
  recall: number;
  accuracy: number;
  emitted: number;
  /** Emitted markers the parser reduced below two chips, so nothing shows. */
  dropped: number;
  formatPass: number;
  meanQuality: number;
  coverage: number;
  judged: number;
};

function metrics(rows: Row[]): Metrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const r of rows) {
    const shown = r.shown !== null;
    if (shown && r.item.should_show) tp++;
    else if (shown) fp++;
    else if (r.item.should_show) fn++;
    else tn++;
  }
  const emitted = rows.filter((r) => r.rawLabels !== null);
  const judged = rows.filter((r) => r.judged !== null);
  const mean = (xs: number[]) =>
    xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    n: rows.length,
    tp,
    fp,
    fn,
    tn,
    malformed: rows.filter((r) => r.line === null).length,
    precision: tp / (tp + fp),
    recall: tp / (tp + fn),
    accuracy: (tp + tn) / rows.length,
    emitted: emitted.length,
    dropped: emitted.filter((r) => r.shown === null).length,
    formatPass: emitted.filter((r) => r.formatOk).length / emitted.length,
    meanQuality: mean(judged.map((r) => r.judged!.quality)),
    coverage: mean(judged.map((r) => r.coverage!)),
    judged: judged.length,
  };
}

/** Higher is worse: wrong show decision, then malformed format, then low quality and coverage. */
function badness(r: Row): number {
  const shown = r.shown !== null;
  let b = 0;
  if (shown !== r.item.should_show) b += 100;
  if (r.line === null) b += 90;
  if (r.formatOk === false) b += 50;
  if (r.judged !== null) b += (2 - r.judged.quality) * 20 + (1 - (r.coverage ?? 0)) * 10;
  return b;
}

const pct = (x: number) => (Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(0)}%`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const chips = (xs: string[] | null) =>
  xs === null || xs.length === 0 ? "" : xs.map((x) => `\`${x}\``).join(" ");

function questionExcerpt(text: string): string {
  const sentences = text
    .trim()
    .split(/(?<=[.!?]["'”)]*)\s+|\n+/)
    .filter((s) => s.trim().length > 0);
  const last = sentences[sentences.length - 1] ?? "";
  return last.length > 110 ? `…${last.slice(-110)}` : last;
}

const handReview: Record<string, string> = existsSync(handReviewPath)
  ? (JSON.parse(readFileSync(handReviewPath, "utf8")) as Record<string, string>)
  : {};

const byModel = modelKeys.map((key) => ({ key, rows: items.map((it) => evaluate(key, it)) }));
const md: string[] = [];
md.push(`# Reply chips eval, ${date}${variant === "spec" ? "" : ` (rule variant: ${variant})`}`);
md.push("");
md.push(
  `Dataset: ${items.length} real Nova and Astra replies (${items.filter((i) => i.should_show).length} gold show, ${items.filter((i) => !i.should_show).length} gold no-show). ` +
    `Generator prompt: ${variant === "spec" ? "the spec's Rules text verbatim" : `the \`${variant}\` rule variant in run.ts`}, \`--thinking off\`. Judge: ${JUDGE_MODEL} on true positives. See README.md.`,
);
md.push("");
md.push("## Summary");
md.push("");
md.push(
  "| Model | TP | FP | FN | TN | No answer | Precision | Recall | Accuracy | Format pass (emitted) | Dropped by parser | Mean quality (0-2) | Coverage |",
);
md.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const { key, rows } of byModel) {
  const m = metrics(rows);
  md.push(
    `| ${MODELS[key]} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} | ${m.malformed} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.accuracy)} | ${pct(m.formatPass)} (${m.emitted}) | ${m.dropped} | ${Number.isNaN(m.meanQuality) ? "n/a" : m.meanQuality.toFixed(2)} (${m.judged}) | ${pct(m.coverage)} |`,
  );
}
md.push("");
md.push(
  "Shown means `splitReplies` left two or more chips. Format pass counts emitted markers whose raw labels already meet the spec (2 to 4, nonempty, at most 24 characters, distinct) before the parser filters them. Dropped by parser counts emitted markers left with fewer than two chips after the parser drops over-long labels, so nothing shows. Quality and coverage cover true positives only.",
);
md.push("");
md.push("Cost (omp's list-price estimate from token usage; `--thinking off`):");
md.push("");
md.push("| Calls | Count | Mean tokens in | Mean tokens out | Total USD |");
md.push("|---|---|---|---|---|");
for (const [label, type, model] of [
  ...modelKeys.map((key) => [`${MODELS[key]} generate`, "gen", key] as const),
  ...modelKeys.map((key) => [`${JUDGE_MODEL} judge (${key} rows)`, "judge", key] as const),
]) {
  const calls = [...cache.values()].filter((r) => r.type === type && r.model === model);
  const sum = (f: (r: CacheRow) => number) => calls.reduce((a, r) => a + f(r), 0);
  md.push(
    `| ${label} | ${calls.length} | ${(sum((r) => r.tokensIn) / calls.length).toFixed(0)} | ${(sum((r) => r.tokensOut) / calls.length).toFixed(0)} | $${sum((r) => r.costUsd).toFixed(3)} |`,
  );
}

for (const { key, rows } of byModel) {
  md.push("");
  md.push(`## ${MODELS[key]}`);
  md.push("");
  md.push(
    "| Id | Agent | Kind | Question excerpt | Gold show | Gold chips | Predicted chips | Show correct | Format | Quality | Coverage | Judge note |",
  );
  md.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const predicted =
      r.line === null ? "(no answer)" : r.line === "NONE" ? "NONE" : chips(r.rawLabels);
    md.push(
      `| ${r.item.id} | ${r.item.agent} | ${r.item.kind} | ${cell(questionExcerpt(r.item.assistant))} | ${r.item.should_show ? "yes" : "no"} | ${cell(chips(r.item.gold))} | ${cell(predicted)} | ${(r.shown !== null) === r.item.should_show ? "yes" : "**no**"} | ${r.formatOk === null ? "" : r.formatOk ? "ok" : "**fail**"} | ${r.judged?.quality ?? ""} | ${r.coverage === null ? "" : pct(r.coverage)} | ${cell(r.judged?.why ?? "")} |`,
    );
  }
  md.push("");
  md.push(`### Worst 5 (${key}), hand review`);
  md.push("");
  md.push("| Id | Gold chips | Predicted | Hand review |");
  md.push("|---|---|---|---|");
  const worst = [...rows].sort((a, b) => badness(b) - badness(a)).slice(0, 5);
  for (const r of worst) {
    const predicted =
      r.line === null ? "(no answer)" : r.line === "NONE" ? "NONE" : chips(r.rawLabels);
    md.push(
      `| ${r.item.id} | ${cell(chips(r.item.gold)) || "(no chips)"} | ${cell(predicted)} | ${cell(handReview[`${key}:${r.item.id}`] ?? "(not reviewed)")} |`,
    );
  }
}
md.push("");
writeFileSync(resultsPath, md.join("\n"));

for (const { key, rows } of byModel) {
  const m = metrics(rows);
  console.log(
    `${key}: P ${pct(m.precision)} R ${pct(m.recall)} Acc ${pct(m.accuracy)} format ${pct(m.formatPass)} quality ${m.meanQuality.toFixed(2)} coverage ${pct(m.coverage)} (tp ${m.tp} fp ${m.fp} fn ${m.fn} tn ${m.tn}, no answer ${m.malformed})`,
  );
}
console.log(`wrote ${resultsPath}`);
