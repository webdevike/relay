#!/usr/bin/env bun
/**
 * prop-render bake-off for a blind pick: every subject in `cases.json` (or `--cases`) rendered by each arm through the agent as shipped
 * (`prop-render.json` with the arm's `agent.harness`, its model, the `blender.render` check with its repair), no bus,
 * nothing in the journal. An arm is `<harness>:<model>`, so harnesses compare with the model held fixed.
 *
 *     bun domains/render/bench/bake.ts --arms omp:openai-codex/gpt-6-astra,codex:openai-codex/gpt-6-astra --out dir [--key dir] [--cases file]
 *
 * `--out` gets what Isaac judges and nothing that names an arm: per case `<case>.png`, a contact sheet of every arm's
 * render labelled A, B, C, ... (arms shuffled per case), `<case>-<label>.png` full size and `<case>-<label>.glb`, and
 * `README.md` with each case's subject. `--key` (default `<out>-key/`) gets the rest: `key.json` (which arm is which
 * label per case, with its cost, seconds, attempts and tokens), `results.md` (per arm totals), `runs.jsonl` (one line
 * per render with every model call) and every run dir (scripts, renders). A run dir with a `result.json` is reused,
 * so a crashed bake resumes where it stopped.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { chromium } from "playwright-core";
import { Adapters, type ModelAdapter } from "../../../src/core/Adapter.ts";
import { Agents, parseAgent } from "../../../src/core/Agent.ts";
import { EventBus, Home } from "../../../src/core/Event.ts";
import { ModelRunner } from "../../../src/core/Model.ts";
import { Settings } from "../../../src/core/Settings.ts";
import { packs } from "../../../src/packs.ts";

const Case = Schema.Struct({ id: Schema.NonEmptyString, subject: Schema.NonEmptyString });
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

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Every arm's render in one image, labelled, two per row, at a size the eye compares at. */
const contactSheet = (
  cells: ReadonlyArray<{ readonly label: string; readonly rendered: Rendered }>,
  title: string,
  out: string,
) =>
  Effect.tryPromise(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 1680, height: 900 },
        deviceScaleFactor: 1,
      });
      // Inline: a page set from a string is about:blank, which may not load file:// images.
      const figure = async ({ label, rendered }: (typeof cells)[number]) =>
        `<figure><figcaption>${label}</figcaption>${
          rendered.image === undefined
            ? `<div class="failed">No render: ${escape(rendered.error ?? "unknown error")}</div>`
            : `<img src="data:image/png;base64,${Buffer.from(await Bun.file(rendered.image).arrayBuffer()).toString("base64")}">`
        }</figure>`;
      const figures = await Promise.all(cells.map(figure));
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>
          body{margin:0;padding:32px;background:#1b1d26;color:#f5f5f5;font:500 20px system-ui}
          h1{font-size:24px;font-weight:500;margin:0 0 20px;color:#bfc0c0}
          main{display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:start}
          figure{margin:0}figcaption{font-size:40px;font-weight:700;margin-bottom:10px}
          img{width:100%;display:block;border:1px solid #3a3f52}
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
  for (const arm of arms) {
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
  const specFile = path.join(here, "..", "prop-render.json");
  const specText = yield* fs.readFileString(specFile);
  const cases = yield* decodeCases(
    yield* fs.readFileString(path.resolve(flag("cases") ?? path.join(here, "cases.json"))),
  );
  yield* fs.makeDirectory(out, { recursive: true });
  yield* fs.makeDirectory(keyDir, { recursive: true });
  yield* Console.log(`${cases.length} cases x ${arms.length} arms; judge ${out}; key ${keyDir}\n`);

  const render = (arm: string, item: typeof Case.Type) =>
    Effect.gen(function* () {
      const harness = arm.slice(0, arm.indexOf(":"));
      const model = arm.slice(arm.indexOf(":") + 1);
      const runDir = path.join(keyDir, "runs", arm.replace(/[/:]/g, "_"), item.id);
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
      const raw = JSON.parse(specText) as { agent: Record<string, unknown> };
      const loaded = yield* parseAgent(
        specFile,
        JSON.stringify({ ...raw, agent: { ...raw.agent, harness } }),
      ).pipe(Effect.provideService(Adapters, Adapters.of({ ...registry, models: tallied })));
      const result = yield* loaded.modelStage!.item(
        { subject: item.subject },
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
          const runDir = path.join(keyDir, "runs", arm.replace(/[/:]/g, "_"), item.id);
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

  // One case at a time with every arm at once, so each arm renders under the same load.
  const results = yield* Effect.forEach(cases, (item) =>
    Effect.forEach(arms, (arm) => render(arm, item), { concurrency: "unbounded" }),
  );

  const labels = "ABCDEFGHIJ";
  const key: Record<string, Record<string, Rendered>> = {};
  const readme = [
    "# prop-render bake-off: blind",
    "",
    `Each object was rendered ${arms.length} ways; the renders are shuffled per object and labelled ${labels.slice(0, arms.length).split("").join(", ")}. The key is kept elsewhere. Rank the labels per object (best first), or pick a best.`,
    "",
  ];
  for (const [index, item] of cases.entries()) {
    const shuffled = [...results[index]!]
      .map((rendered) => ({ rendered, order: Math.random() }))
      .sort((a, b) => a.order - b.order)
      .map(({ rendered }, at) => ({ label: labels[at]!, rendered }));
    key[item.id] = Object.fromEntries(shuffled.map(({ label, rendered }) => [label, rendered]));
    for (const { label, rendered } of shuffled) {
      if (rendered.image !== undefined)
        yield* fs.copyFile(rendered.image, path.join(out, `${item.id}-${label}.png`));
      if (rendered.glb !== undefined)
        yield* fs.copyFile(rendered.glb, path.join(out, `${item.id}-${label}.glb`));
    }
    yield* contactSheet(shuffled, `${item.id}: ${item.subject}`, path.join(out, `${item.id}.png`));
    readme.push(
      `## ${item.id}: ${item.subject}`,
      "",
      `- Contact sheet: \`${item.id}.png\``,
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
        row.map((rendered) => JSON.stringify({ case: cases[index]!.id, ...rendered })),
      )
      .join("\n") + "\n",
  );

  const table = [
    "| arm | renders | $ total | $ per render | median s | total s | calls per render | tokens in / cached / out |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const [index, arm] of arms.entries()) {
    const rows = results.map((row) => row[index]!);
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
      `| ${arm} | ${ok.length}/${rows.length} | ${cost.toFixed(3)} | ${(cost / rows.length).toFixed(3)} | ${(seconds[Math.floor(seconds.length / 2)] ?? Number.NaN).toFixed(0)} | ${seconds.reduce((sum, value) => sum + value, 0).toFixed(0)} | ${(rows.reduce((sum, row) => sum + row.attempts, 0) / rows.length).toFixed(1)} | ${tokens.input} / ${tokens.cachedInput} / ${tokens.output} |`,
    );
  }
  yield* fs.writeFileString(path.join(keyDir, "results.md"), `${table.join("\n")}\n`);
  yield* Console.log(
    `\n${table.join("\n")}\n\njudge: ${out}\nkey:   ${path.join(keyDir, "key.json")}`,
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
