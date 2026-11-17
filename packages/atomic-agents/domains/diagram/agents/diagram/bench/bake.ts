#!/usr/bin/env bun
/**
 * diagram bake-off for a blind pick: every case in `cases.json` drawn by two models through the agent as shipped
 * (`Agent.modelStage`: brief step, model, render check with its repair), no bus, nothing in the journal.
 *
 *     bun domains/diagram/agents/diagram/bench/bake.ts [--models a,b] [--out dir] [--key dir] [--recompose]
 *
 * `--out` (default `<home>/bench/diagram/bake`) gets what Isaac judges and nothing that names a model: per case `<case>.png`, the
 * two diagrams side by side as A and B (sides drawn at random per case), `<case>-A.png` and `<case>-B.png` full
 * size, and `README.md` with each case's request. `--key` (default `<out>-key/`) gets the rest: `key.json` (which model
 * is A and B per case, and each arm's model, cost, seconds, attempts, warnings, summary), `results.md`, and every run dir.
 * `--recompose` only rebuilds the side-by-side images from the A and B images already in `--out` (no model calls).
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { chromium } from "playwright-core";
import { Adapters } from "../../../../../src/core/Adapter.ts";
import { Agents } from "../../../../../src/core/Agent.ts";
import { EventBus, Home } from "../../../../../src/core/Event.ts";
import { ModelRunner } from "../../../../../src/core/Model.ts";
import { effective, Settings } from "../../../../../src/core/Settings.ts";
import { packs } from "../../../../../src/packs.ts";

const Case = Schema.Struct({
  id: Schema.NonEmptyString,
  input: Schema.Record(Schema.String, Schema.Unknown),
});
const decodeCases = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Case)));
/** What a blind pick needs of an item's fields (`diagram.rendered` without the run stats the bench keeps itself). */
const decodeDrawn = Schema.decodeUnknownEffect(
  Schema.Struct({
    image: Schema.String,
    summary: Schema.String,
    warnings: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

interface Drawn {
  readonly model: string;
  readonly image: string | undefined;
  readonly cost: number;
  readonly seconds: number;
  readonly attempts: number;
  readonly warnings: ReadonlyArray<string>;
  readonly summary: string;
  readonly error: string | undefined;
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The two sides in one image, A left and B right, at a width the eye compares at. */
const sideBySide = (
  sides: ReadonlyArray<{ readonly label: string; readonly drawn: Drawn }>,
  title: string,
  out: string,
) =>
  Effect.tryPromise(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 2400, height: 900 },
        deviceScaleFactor: 1,
      });
      // Inline: a page set from a string is about:blank, which may not load file:// images.
      const cell = async ({ label, drawn }: (typeof sides)[number]) =>
        `<figure><figcaption>${label}</figcaption>${
          drawn.image === undefined
            ? `<div class="failed">No diagram: ${escape(drawn.error ?? "unknown error")}</div>`
            : `<img src="data:image/png;base64,${Buffer.from(await Bun.file(drawn.image).arrayBuffer()).toString("base64")}">`
        }</figure>`;
      const cells = await Promise.all(sides.map(cell));
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>
          body{margin:0;padding:32px;background:#1b1d26;color:#f5f5f5;font:500 20px system-ui}
          h1{font-size:22px;font-weight:500;margin:0 0 20px;color:#bfc0c0}
          main{display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:start}
          figure{margin:0}figcaption{font-size:44px;font-weight:700;margin-bottom:12px}
          img{width:100%;display:block;border:1px solid #3a3f52}
          .failed{padding:48px;border:1px dashed #8f5e4e;color:#f0b196}
        </style></head><body><h1>${escape(title)}</h1><main>${cells.join("")}</main></body></html>`,
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
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at < 0 ? undefined : args[at + 1];
  };
  const here = path.dirname(new URL(import.meta.url).pathname);
  const agent = (yield* (yield* Agents).current).find((candidate) => candidate.id === "diagram");
  if (agent?.modelStage === undefined)
    return yield* Effect.fail(new Error("no diagram agent loaded"));
  const modelStage = agent.modelStage;
  const resolved = effective(agent, yield* (yield* Settings).current).agent;
  const models = flag("models")?.split(",") ?? resolved.candidates.slice(0, 2);
  if (models.length !== 2)
    return yield* Effect.fail(
      new Error(`a blind pick needs exactly two models (got ${models.join(", ")})`),
    );
  const out = path.resolve(
    flag("out") ?? path.join((yield* Home).root, "bench", "diagram", "bake"),
  );
  const keyDir = path.resolve(flag("key") ?? `${out}-key`);
  const cases = yield* decodeCases(yield* fs.readFileString(path.join(here, "cases.json")));
  yield* fs.makeDirectory(out, { recursive: true });
  yield* fs.makeDirectory(keyDir, { recursive: true });
  const caption = (item: typeof Case.Type) =>
    `${item.id}: ${String(item.input["title"] ?? item.input["kind"] ?? "")}`;

  if (args.includes("--recompose")) {
    for (const item of cases) {
      const sides = yield* Effect.forEach(["A", "B"], (label) =>
        Effect.map(fs.exists(path.join(out, `${item.id}-${label}.png`)), (exists) => ({
          label,
          drawn: {
            model: "",
            image: exists ? path.join(out, `${item.id}-${label}.png`) : undefined,
            cost: 0,
            seconds: 0,
            attempts: 0,
            warnings: [],
            summary: "",
            error: exists ? undefined : "no image",
          } satisfies Drawn,
        })),
      );
      yield* sideBySide(sides, caption(item), path.join(out, `${item.id}.png`));
    }
    return yield* Console.log(`recomposed ${cases.length} side-by-sides in ${out}`);
  }
  yield* Console.log(
    `${cases.length} cases on ${models.join(" vs ")}; judge ${out}; key ${keyDir}\n`,
  );

  const draw = (model: string, item: typeof Case.Type) =>
    Effect.gen(function* () {
      const runDir = path.join(keyDir, "runs", model.replaceAll("/", "_"), item.id);
      yield* fs.makeDirectory(runDir, { recursive: true });
      const context = {
        component: "diagram",
        job: "draw",
        run: "bench",
        runDir,
        stateDir: runDir,
        model,
        agent: { ...resolved, model },
      };
      const result = yield* modelStage.item(item.input, context);
      const drawn = yield* decodeDrawn(result.fields);
      yield* fs.writeFileString(
        path.join(runDir, "result.json"),
        `${JSON.stringify({ input: item.input, ...result }, null, 2)}\n`,
      );
      return {
        model,
        image: drawn.image,
        cost: result.cost,
        seconds: result.seconds,
        attempts: result.attempts,
        warnings: drawn.warnings ?? [],
        summary: drawn.summary,
        error: undefined,
      } satisfies Drawn;
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed<Drawn>({
          model,
          image: undefined,
          cost: 0,
          seconds: 0,
          attempts: 0,
          warnings: [],
          summary: "",
          error: String("message" in error ? error.message : error),
        }),
      ),
      Effect.tap((drawn) =>
        Console.log(
          `${model.padEnd(32)} ${item.id.padEnd(28)} ${drawn.error === undefined ? `ok  ${drawn.seconds.toFixed(0)} s  $${drawn.cost.toFixed(3)}  ${drawn.attempts} call(s)${drawn.warnings.length > 0 ? `  ${drawn.warnings.length} warning(s)` : ""}` : `FAIL ${drawn.error.slice(0, 120)}`}`,
        ),
      ),
    );

  const results = yield* Effect.forEach(
    models,
    (model) => Effect.forEach(cases, (item) => draw(model, item), { concurrency: 3 }),
    { concurrency: "unbounded" },
  );

  const key: Record<string, Record<string, Drawn>> = {};
  const readme = [
    "# Diagram bake-off: blind",
    "",
    "Each case was drawn by two models. Sides are random per case; the key is kept elsewhere. Pick A, B or tie per case.",
    "",
  ];
  for (const [index, item] of cases.entries()) {
    const pair = [results[0]![index]!, results[1]![index]!];
    if (Math.random() < 0.5) pair.reverse();
    const sides = pair.map((drawn, side) => ({ label: side === 0 ? "A" : "B", drawn }));
    key[item.id] = Object.fromEntries(sides.map(({ label, drawn }) => [label, drawn]));
    for (const { label, drawn } of sides) {
      if (drawn.image !== undefined)
        yield* fs.copyFile(drawn.image, path.join(out, `${item.id}-${label}.png`));
    }
    yield* sideBySide(sides, caption(item), path.join(out, `${item.id}.png`));
    readme.push(
      `## ${item.id}`,
      "",
      `- Side by side: \`${item.id}.png\`; full size: \`${item.id}-A.png\`, \`${item.id}-B.png\``,
      `- Request: \`${JSON.stringify(item.input)}\``,
      "",
    );
  }
  yield* fs.writeFileString(path.join(out, "README.md"), `${readme.join("\n")}\n`);
  yield* fs.writeFileString(path.join(keyDir, "key.json"), `${JSON.stringify(key, null, 2)}\n`);

  const table = [
    "| model | cases drawn | $ total | $ per case | p50 s | calls per case | warnings |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const [index, model] of models.entries()) {
    const rows = results[index]!;
    const ok = rows.filter((row) => row.error === undefined);
    const seconds = ok.map((row) => row.seconds).sort((a, b) => a - b);
    const cost = rows.reduce((sum, row) => sum + row.cost, 0);
    table.push(
      `| ${model} | ${ok.length}/${rows.length} | ${cost.toFixed(3)} | ${(cost / rows.length).toFixed(3)} | ${(seconds[Math.floor(seconds.length / 2)] ?? Number.NaN).toFixed(0)} | ${(rows.reduce((sum, row) => sum + row.attempts, 0) / rows.length).toFixed(1)} | ${rows.reduce((sum, row) => sum + row.warnings.length, 0)} |`,
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
