#!/usr/bin/env bun
/**
 * prop-render bake-off for a blind pick: every case in `cases.json` (or `--cases`) rendered by each arm through the agent as shipped
 * (`AGENT.md` with the arm's harness, its model, the `render.reference` step, the `blender.render` check with its repair), no bus,
 * nothing in the journal. An arm is `<harness>:<model>`, so harnesses compare with the model held fixed. A case is
 * `{id, subject, reference?}`; with a reference (an absolute image path or a drop) the arms must match that image.
 *
 *     bun domains/render/agents/prop-render/bench/bake.ts --arms omp:openai-codex/gpt-6-astra,codex:openai-codex/gpt-6-astra --out dir [--key dir] [--cases file] [--judge omp:anthropic/claude-opus-5-5]
 *
 * `--out` gets what Isaac judges and nothing that names an arm: per case `<case>.png`, a contact sheet (the reference
 * first when the case has one, then every arm's render labelled A, B, C, ..., arms shuffled per case), `<case>-<label>.png`
 * full size and `<case>-<label>.glb`, and `README.md` with each case's subject. `--key` (default `<out>-key/`) gets the
 * rest: `key.json` (which arm is which label per case, with its cost, seconds, attempts, tokens and score), `results.md`
 * (per arm totals), `runs.jsonl` (one line per render with every model call) and every run dir (scripts, renders).
 * `--judge` scores each render of a case with a reference: a vision model sees the reference and the render, unnamed,
 * and rates silhouette, proportions, color and overall match 1-10; scores go to the key only. A run dir with a
 * `result.json` (and `score.json`) is reused, so a crashed bake resumes where it stopped.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { chromium } from "playwright-core";
import { Adapters, type ModelAdapter } from "../../../../../src/core/Adapter.ts";
import { Agents, parseAgent } from "../../../../../src/core/Agent.ts";
import { EventBus, Home } from "../../../../../src/core/Event.ts";
import { ModelRunner } from "../../../../../src/core/Model.ts";
import { Settings } from "../../../../../src/core/Settings.ts";
import { packs } from "../../../../../src/packs.ts";

const Case = Schema.Struct({
  id: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
  reference: Schema.optionalKey(Schema.NonEmptyString),
});
const decodeCases = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Case)));
const decodeRendered = Schema.decodeUnknownEffect(
  Schema.Struct({ image: Schema.String, glb: Schema.String }),
);

/** One model call of a render, as its harness reported it. */
const Call = Schema.Struct({
  provider: Schema.String,
  seconds: Schema.Number,
  cost: Schema.Number,
  tokens: Schema.optional(
    Schema.Struct({ input: Schema.Number, output: Schema.Number, cachedInput: Schema.Number }),
  ),
});
type Call = typeof Call.Type;

/** A judge's 1-10 ratings of how closely a render matches its reference. */
const Score = Schema.Struct({
  silhouette: Schema.Number,
  proportions: Schema.Number,
  color: Schema.Number,
  overall: Schema.Number,
  note: Schema.String,
});
type Score = typeof Score.Type;
const decodeScore = Schema.decodeUnknownEffect(Schema.fromJsonString(Score));

/** One arm's render of one case: its files, or why it has none, and what it took. */
const Rendered = Schema.Struct({
  arm: Schema.String,
  harness: Schema.String,
  model: Schema.String,
  image: Schema.optional(Schema.String),
  glb: Schema.optional(Schema.String),
  cost: Schema.Number,
  seconds: Schema.Number,
  attempts: Schema.Number,
  calls: Schema.Array(Call),
  error: Schema.optional(Schema.String),
});
type Rendered = typeof Rendered.Type;
const decodeSaved = Schema.decodeUnknownEffect(Schema.fromJsonString(Rendered));

const JUDGE_SYSTEM =
  "You compare a 3D render against the reference image it was meant to match. You judge only resemblance, not quality or polish. Ignore the background, the floor and the lighting setup.";
const JUDGE_PROMPT = [
  "The first attached image is the reference, the second is a render of a 3D model built to match it.",
  "Rate from 1 (nothing alike) to 10 (the same object, as seen from the same angle):",
  "- silhouette: the outline and the camera angle",
  "- proportions: relative sizes and placement of the parts",
  "- color: the materials and colors",
  "- overall: would someone shown both say it is the reference made in 3D",
  'Reply with JSON only: {"silhouette": n, "proportions": n, "color": n, "overall": n, "note": "<one sentence: the biggest difference>"}',
].join("\n");

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The reference (when there is one) on the left, then every arm's render, labelled, in one row the eye compares across. */
const contactSheet = (
  reference: string | undefined,
  cells: ReadonlyArray<{ readonly label: string; readonly rendered: Rendered }>,
  title: string,
  out: string,
) =>
  Effect.tryPromise(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const columns = cells.length + (reference === undefined ? 0 : 1);
      const page = await browser.newPage({
        viewport: { width: 64 + columns * 560, height: 700 },
        deviceScaleFactor: 1,
      });
      // Inline: a page set from a string is about:blank, which may not load file:// images.
      const inline = async (file: string) =>
        `data:${Bun.file(file).type};base64,${Buffer.from(await Bun.file(file).arrayBuffer()).toString("base64")}`;
      const figures = [
        ...(reference === undefined
          ? []
          : [
              `<figure class="reference"><figcaption>Reference</figcaption><img src="${await inline(reference)}"></figure>`,
            ]),
        ...(await Promise.all(
          cells.map(
            async ({ label, rendered }) =>
              `<figure><figcaption>${label}</figcaption>${
                rendered.image === undefined
                  ? `<div class="failed">No render: ${escape(rendered.error ?? "unknown error")}</div>`
                  : `<img src="${await inline(rendered.image)}">`
              }</figure>`,
          ),
        )),
      ];
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>
          body{margin:0;padding:32px;background:#1b1d26;color:#f5f5f5;font:500 20px system-ui}
          h1{font-size:24px;font-weight:500;margin:0 0 20px;color:#bfc0c0}
          main{display:grid;grid-template-columns:repeat(${columns},1fr);gap:32px;align-items:start}
          figure{margin:0}figcaption{font-size:40px;font-weight:700;margin-bottom:10px}
          img{width:100%;aspect-ratio:1;object-fit:contain;display:block;border:1px solid #3a3f52}
          .reference img{background:#c7cbd3}.reference figcaption{color:#9fd3a8}
          .failed{aspect-ratio:1;padding:48px;border:1px dashed #8f5e4e;color:#f0b196;box-sizing:border-box}
        </style></head><body><h1>${escape(title)}</h1><main>${figures.join("")}</main></body></html>`,
        { waitUntil: "load" },
      );
      await page.screenshot({ path: out, fullPage: true });
    } finally {
      await browser.close();
    }
  });

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const registry = yield* Adapters;
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at < 0 ? undefined : args[at + 1];
  };
  const here = path.dirname(new URL(import.meta.url).pathname);
  const arms = (flag("arms") ?? "").split(",").filter((arm) => arm !== "");
  if (arms.length < 2)
    return yield* Effect.fail(new Error("--arms needs two or more <harness>:<model>"));
  const judge = flag("judge");
  for (const arm of [...arms, ...(judge === undefined ? [] : [judge])]) {
    const harness = arm.slice(0, arm.indexOf(":"));
    if (!registry.models.has(harness)) {
      return yield* Effect.fail(
        new Error(
          `${arm}: no harness ${harness} (have: ${[...registry.models.keys()].join(", ")})`,
        ),
      );
    }
  }
  const outFlag = flag("out");
  if (outFlag === undefined) return yield* Effect.fail(new Error("--out <dir> is required"));
  const out = path.resolve(outFlag);
  const keyDir = path.resolve(flag("key") ?? `${out}-key`);
  const docFile = path.join(here, "..", "AGENT.md");
  const docText = yield* fs.readFileString(docFile);
  const cases = yield* decodeCases(
    yield* fs.readFileString(path.resolve(flag("cases") ?? path.join(here, "cases.json"))),
  );
  yield* fs.makeDirectory(out, { recursive: true });
  yield* fs.makeDirectory(keyDir, { recursive: true });
  yield* Console.log(`${cases.length} cases x ${arms.length} arms; judge ${out}; key ${keyDir}\n`);

  const runDirOf = (arm: string, item: typeof Case.Type) =>
    path.join(keyDir, "runs", arm.replace(/[/:]/g, "_"), item.id);

  const render = (arm: string, item: typeof Case.Type) =>
    Effect.gen(function* () {
      const harness = arm.slice(0, arm.indexOf(":"));
      const model = arm.slice(arm.indexOf(":") + 1);
      const runDir = runDirOf(arm, item);
      const saved = path.join(runDir, "result.json");
      if (yield* fs.exists(saved)) return yield* decodeSaved(yield* fs.readFileString(saved));
      yield* fs.makeDirectory(runDir, { recursive: true });
      // The agent as shipped with the arm's harness; its harness adapter tallies every call this render makes.
      const calls: Array<Call> = [];
      const tallied = new Map(
        [...registry.models].map(([name, adapter]): [string, ModelAdapter] => [
          name,
          {
            ...adapter,
            generate: (request) =>
              Effect.tap(adapter.generate(request), (generation) =>
                Effect.sync(() =>
                  calls.push({
                    provider: generation.provider,
                    seconds: generation.seconds,
                    cost: generation.cost,
                    tokens: generation.tokens,
                  }),
                ),
              ),
          },
        ]),
      );
      const loaded = yield* parseAgent(
        docFile,
        docText.replace(/^---\r?\n/, `---\nharness: ${harness}\n`),
      ).pipe(Effect.provideService(Adapters, Adapters.of({ ...registry, models: tallied })));
      const result = yield* loaded.modelStage!.item(
        {
          subject: item.subject,
          ...(item.reference === undefined ? {} : { reference: item.reference }),
        },
        {
          component: "prop-render",
          job: "render",
          run: "bench",
          runDir,
          stateDir: runDir,
          model,
          agent: { ...loaded.agent.agent, model },
        },
      );
      const files = yield* decodeRendered(result.fields);
      return {
        arm,
        harness,
        model,
        image: files.image,
        glb: files.glb,
        cost: result.cost,
        seconds: result.seconds,
        attempts: result.attempts,
        calls,
        error: undefined,
      } satisfies Rendered;
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed<Rendered>({
          arm,
          harness: arm.slice(0, arm.indexOf(":")),
          model: arm.slice(arm.indexOf(":") + 1),
          image: undefined,
          glb: undefined,
          cost: 0,
          seconds: 0,
          attempts: 0,
          calls: [],
          error: String(
            typeof error === "object" && error !== null && "message" in error
              ? error.message
              : error,
          ),
        }),
      ),
      Effect.tap((rendered) =>
        Effect.gen(function* () {
          const runDir = runDirOf(arm, item);
          yield* fs.makeDirectory(runDir, { recursive: true });
          // A failed render is not saved, so a resumed bake tries it again.
          if (rendered.error === undefined) {
            yield* fs.writeFileString(
              path.join(runDir, "result.json"),
              `${JSON.stringify(rendered, null, 2)}\n`,
            );
          }
          yield* Console.log(
            `${arm.padEnd(42)} ${item.id.padEnd(20)} ${rendered.error === undefined ? `ok  ${rendered.seconds.toFixed(0)} s  $${rendered.cost.toFixed(3)}  ${rendered.attempts} call(s)` : `FAIL ${rendered.error.slice(0, 160)}`}`,
          );
        }),
      ),
    );

  /** The judge's ratings of one render against the case's reference; undefined without a judge, reference or render. */
  const score = (rendered: Rendered, item: typeof Case.Type) =>
    Effect.gen(function* () {
      if (judge === undefined || rendered.image === undefined) return undefined;
      const runDir = runDirOf(rendered.arm, item);
      const reference = (yield* fs.readDirectory(runDir)).find((name) =>
        name.startsWith("reference."),
      );
      if (reference === undefined) return undefined;
      const saved = path.join(runDir, "score.json");
      if (yield* fs.exists(saved)) return yield* decodeScore(yield* fs.readFileString(saved));
      const generation = yield* registry.models.get(judge.slice(0, judge.indexOf(":")))!.generate({
        model: judge.slice(judge.indexOf(":") + 1),
        system: JUDGE_SYSTEM,
        prompt: JUDGE_PROMPT,
        files: [path.join(runDir, reference), rendered.image],
        thinking: "low",
      });
      const json = /\{[\s\S]*\}/.exec(generation.text)?.[0] ?? generation.text;
      const ratings = yield* decodeScore(json);
      yield* fs.writeFileString(saved, `${JSON.stringify(ratings, null, 2)}\n`);
      return ratings;
    }).pipe(
      Effect.catch((error) =>
        Console.log(`judge ${rendered.arm} ${item.id}: ${String(error)}`).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  // One case at a time with every arm at once, so each arm renders under the same load.
  const results = yield* Effect.forEach(cases, (item) =>
    Effect.forEach(arms, (arm) => render(arm, item), { concurrency: "unbounded" }),
  );
  const scores = yield* Effect.forEach(cases, (item, index) =>
    Effect.forEach(results[index]!, (rendered) => score(rendered, item), {
      concurrency: "unbounded",
    }),
  );

  const labels = "ABCDEFGHIJ";
  const key: Record<string, Record<string, Rendered & { readonly score: Score | undefined }>> = {};
  const readme = [
    "# prop-render bake-off: blind",
    "",
    `Each object was rendered ${arms.length} ways; the renders are shuffled per object and labelled ${labels.slice(0, arms.length).split("").join(", ")}. Where a case has a reference image, it is on the left of the sheet and the renders were built to match it. The key is kept elsewhere. Rank the labels per object (best first), or pick a best.`,
    "",
  ];
  for (const [index, item] of cases.entries()) {
    const shuffled = results[index]!.map((rendered, arm) => ({
      rendered,
      score: scores[index]![arm],
      order: Math.random(),
    }))
      .sort((a, b) => a.order - b.order)
      .map(({ rendered, score }, at) => ({ label: labels[at]!, rendered, score }));
    key[item.id] = Object.fromEntries(
      shuffled.map(({ label, rendered, score }) => [label, { ...rendered, score }]),
    );
    for (const { label, rendered } of shuffled) {
      if (rendered.image !== undefined)
        yield* fs.copyFile(rendered.image, path.join(out, `${item.id}-${label}.png`));
      if (rendered.glb !== undefined)
        yield* fs.copyFile(rendered.glb, path.join(out, `${item.id}-${label}.glb`));
    }
    // The reference as the agent saw it (a drop is fetched by the step into each run dir).
    const runDir = runDirOf(arms[0]!, item);
    const copied = (yield* fs.readDirectory(runDir).pipe(Effect.orElseSucceed(() => []))).find(
      (name) => name.startsWith("reference."),
    );
    const reference = copied === undefined ? undefined : path.join(out, `${item.id}-${copied}`);
    if (copied !== undefined && reference !== undefined)
      yield* fs.copyFile(path.join(runDir, copied), reference);
    yield* contactSheet(
      reference,
      shuffled,
      `${item.id}: ${item.subject}`,
      path.join(out, `${item.id}.png`),
    );
    readme.push(
      `## ${item.id}: ${item.subject}`,
      "",
      `- Contact sheet: \`${item.id}.png\``,
      ...(reference === undefined ? [] : [`- Reference: \`${path.basename(reference)}\``]),
      ...shuffled.map(({ label, rendered }) =>
        rendered.image === undefined
          ? `- ${label}: no render`
          : `- ${label}: \`${item.id}-${label}.png\`, model \`${item.id}-${label}.glb\``,
      ),
      "",
    );
  }
  yield* fs.writeFileString(path.join(out, "README.md"), `${readme.join("\n")}\n`);
  yield* fs.writeFileString(path.join(keyDir, "key.json"), `${JSON.stringify(key, null, 2)}\n`);
  yield* fs.writeFileString(
    path.join(keyDir, "runs.jsonl"),
    results
      .flatMap((row, index) =>
        row.map((rendered, arm) =>
          JSON.stringify({ case: cases[index]!.id, ...rendered, score: scores[index]![arm] }),
        ),
      )
      .join("\n") + "\n",
  );

  const mean = (values: ReadonlyArray<number>) =>
    values.length === 0
      ? "-"
      : (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
  const table = [
    "| arm | renders | judge overall | silhouette | proportions | color | $ total | median s | calls per render | tokens in / cached / out |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [index, arm] of arms.entries()) {
    const rows = results.map((row) => row[index]!);
    const rated = scores.flatMap((row) => (row[index] === undefined ? [] : [row[index]!]));
    const ok = rows.filter((row) => row.error === undefined);
    const seconds = ok.map((row) => row.seconds).sort((a, b) => a - b);
    const cost = rows.reduce((sum, row) => sum + row.cost, 0);
    const tokens = rows
      .flatMap((row) => row.calls)
      .reduce(
        (sum, call) => ({
          input: sum.input + (call.tokens?.input ?? 0),
          cachedInput: sum.cachedInput + (call.tokens?.cachedInput ?? 0),
          output: sum.output + (call.tokens?.output ?? 0),
        }),
        { input: 0, cachedInput: 0, output: 0 },
      );
    table.push(
      `| ${arm} | ${ok.length}/${rows.length} | ${mean(rated.map((row) => row.overall))} | ${mean(rated.map((row) => row.silhouette))} | ${mean(rated.map((row) => row.proportions))} | ${mean(rated.map((row) => row.color))} | ${cost.toFixed(3)} | ${(seconds[Math.floor(seconds.length / 2)] ?? Number.NaN).toFixed(0)} | ${(rows.reduce((sum, row) => sum + row.attempts, 0) / rows.length).toFixed(1)} | ${tokens.input} / ${tokens.cachedInput} / ${tokens.output} |`,
    );
  }
  const perCase = [
    "",
    `Judge: ${judge ?? "none"} (1-10 per render: silhouette / proportions / color / overall)`,
    "",
    "| case | label | arm | overall | silhouette | proportions | color | note |",
    "|---|---|---|---|---|---|---|---|",
    ...Object.entries(key).flatMap(([id, labelled]) =>
      Object.entries(labelled).map(
        ([label, entry]) =>
          `| ${id} | ${label} | ${entry.arm} | ${entry.score?.overall ?? "-"} | ${entry.score?.silhouette ?? "-"} | ${entry.score?.proportions ?? "-"} | ${entry.score?.color ?? "-"} | ${entry.score?.note ?? entry.error ?? ""} |`,
      ),
    ),
  ];
  yield* fs.writeFileString(
    path.join(keyDir, "results.md"),
    `${[...table, ...perCase].join("\n")}\n`,
  );
  yield* Console.log(
    `\n${[...table, ...perCase].join("\n")}\n\njudge: ${out}\nkey:   ${path.join(keyDir, "key.json")}`,
  );
});

program.pipe(
  Effect.provide(
    ModelRunner.omp.pipe(
      Layer.provideMerge(Settings.layer),
      Layer.provideMerge(Agents.layer),
      Layer.provideMerge(Adapters.make(packs)),
      Layer.provideMerge(EventBus.layer),
      Layer.provideMerge(Home.layer),
      Layer.provideMerge(BunServices.layer),
    ),
  ),
  BunRuntime.runMain,
);
