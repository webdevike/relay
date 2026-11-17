#!/usr/bin/env bun
/**
 * anti-average bake-off for a blind pick: every case in `cases.json` answered twice on ONE model, by
 *   (agent)    the agent as shipped (`Agent.modelStage`: brief step, instructions and knowledge, check, one repair), and
 *   (baseline) a plain prompt: the same brief, context, count and reply shape, no method, no knowledge, no seed.
 * No bus, nothing in the journal.
 *
 *     bun domains/creative/agents/anti-average/bench/bake.ts [--model m] [--out dir] [--key dir] [--only id,id]
 *
 * `--out` (default `<home>/bench/anti-average/bake`) gets `sheet.md`: per case the request, then two option sets, A and B (sides drawn
 * at random per case), rendered identically, and a ballot. Nothing in it names an arm. `--key` (default `<out>-key/`) gets `key.json`
 * (which arm is A per case, with each arm's cost, seconds and calls), `results.md` and the raw replies.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Adapters } from "../../../../../src/core/Adapter.ts";
import { Agents } from "../../../../../src/core/Agent.ts";
import { EventBus, Home } from "../../../../../src/core/Event.ts";
import { ModelRunner } from "../../../../../src/core/Model.ts";
import { effective, Settings } from "../../../../../src/core/Settings.ts";
import { packs } from "../../../../../src/packs.ts";
import { markdown, parseOptions } from "../../../adapters/pack.ts";
import { CreativeOption, CreativeRequested, DEFAULT_COUNT } from "../../../schema.ts";

const Case = Schema.Struct({ id: Schema.NonEmptyString, input: CreativeRequested });
const decodeCases = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Case)));
const decodeResult = Schema.decodeUnknownEffect(
  Schema.Struct({
    options: Schema.Array(CreativeOption),
    pick: Schema.Int,
    pickWhy: Schema.String,
  }),
);

type Arm = "agent" | "baseline";

interface Answered {
  readonly arm: Arm;
  readonly options: ReadonlyArray<CreativeOption>;
  readonly pick: number;
  readonly pickWhy: string;
  readonly cost: number;
  readonly seconds: number;
  readonly calls: number;
  readonly error: string | undefined;
}

const FAILED = (arm: Arm, error: string, cost = 0, seconds = 0, calls = 0): Answered => ({
  arm,
  options: [],
  pick: 0,
  pickWhy: "",
  cost,
  seconds,
  calls,
  error,
});

/** The plain arm: what a person would type, plus the reply shape so both arms render the same sheet. */
const BASELINE_SYSTEM = [
  "You help with creative work.",
  'Reply with one JSON object and nothing else: {"options": [{"option": "...", "avoided": "...", "why": "..."}], "pick": 1, "pickWhy": "..."}.',
  "`avoided` is the obvious or average choice this option moved away from, in one line; `why` is one sentence on why it fits this project; `pick` is the 1-based number of the option you recommend and `pickWhy` says why.",
].join("\n");

const baselinePrompt = (input: typeof CreativeRequested.Type) =>
  [
    `Give me ${input.count ?? DEFAULT_COUNT} distinct ${input.kind} options for this.`,
    "",
    `Brief: ${input.brief}`,
    ...(input.context === undefined ? [] : ["", `Project context: ${input.context}`]),
  ].join("\n");

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const models = yield* ModelRunner;
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at < 0 ? undefined : args[at + 1];
  };
  const here = path.dirname(new URL(import.meta.url).pathname);
  const agent = (yield* (yield* Agents).current).find(
    (candidate) => candidate.id === "anti-average",
  );
  if (agent?.modelStage === undefined)
    return yield* Effect.fail(new Error("no anti-average agent loaded"));
  const modelStage = agent.modelStage;
  const resolved = effective(agent, yield* (yield* Settings).current).agent;
  const model = flag("model") ?? resolved.model;
  const out = path.resolve(
    flag("out") ?? path.join((yield* Home).root, "bench", "anti-average", "bake"),
  );
  const keyDir = path.resolve(flag("key") ?? `${out}-key`);
  const only = flag("only")?.split(",");
  const cases = (yield* decodeCases(
    yield* fs.readFileString(path.join(here, "cases.json")),
  )).filter((item) => only === undefined || only.includes(item.id));
  yield* fs.makeDirectory(out, { recursive: true });
  yield* fs.makeDirectory(keyDir, { recursive: true });
  yield* Console.log(`${cases.length} cases x 2 arms on ${model}; judge ${out}; key ${keyDir}\n`);

  const runAgent = (item: typeof Case.Type) =>
    Effect.gen(function* () {
      const runDir = path.join(keyDir, "runs", "agent", item.id);
      yield* fs.makeDirectory(runDir, { recursive: true });
      const result = yield* modelStage.item(item.input, {
        component: "anti-average",
        job: "options",
        run: "bench",
        runDir,
        stateDir: runDir,
        model,
        agent: { ...resolved, model },
      });
      const decoded = yield* decodeResult(result.fields);
      yield* fs.writeFileString(
        path.join(runDir, "result.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      return {
        arm: "agent",
        ...decoded,
        cost: result.cost,
        seconds: result.seconds,
        calls: result.attempts,
        error: undefined,
      } satisfies Answered;
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(FAILED("agent", String("message" in error ? error.message : error))),
      ),
    );

  const runBaseline = (item: typeof Case.Type) =>
    Effect.gen(function* () {
      const wanted = item.input.count ?? DEFAULT_COUNT;
      const prompt = baselinePrompt(item.input);
      const ask = (text: string) =>
        models.generate({
          model,
          system: BASELINE_SYSTEM,
          prompt: text,
          ...(resolved.thinking === undefined ? {} : { thinking: resolved.thinking }),
          timeout: "180 seconds",
        });
      const first = yield* ask(prompt);
      let parsed = parseOptions(first.text, wanted, item.input.kind);
      let cost = first.cost;
      let seconds = first.seconds;
      let calls = 1;
      let replies = [first.text];
      if (!parsed.ok) {
        const again = yield* ask(
          [
            prompt,
            "",
            "Your previous reply failed the check:",
            ...parsed.problems.map((problem) => `- ${problem}`),
            "",
            "Your reply:",
            first.text,
            "",
            `Fix every problem and reply again with the one JSON object: exactly ${wanted} options.`,
          ].join("\n"),
        );
        parsed = parseOptions(again.text, wanted, item.input.kind);
        cost += again.cost;
        seconds += again.seconds;
        calls = 2;
        replies = [...replies, again.text];
      }
      const dir = path.join(keyDir, "runs", "baseline", item.id);
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "replies.json"),
        `${JSON.stringify(replies, null, 2)}\n`,
      );
      return parsed.ok
        ? ({
            arm: "baseline",
            options: parsed.options,
            pick: parsed.pick,
            pickWhy: parsed.pickWhy,
            cost,
            seconds,
            calls,
            error: undefined,
          } satisfies Answered)
        : FAILED("baseline", parsed.problems.join("; "), cost, seconds, calls);
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(FAILED("baseline", String("message" in error ? error.message : error))),
      ),
    );

  const results = yield* Effect.forEach(
    cases,
    (item) =>
      Effect.all([runAgent(item), runBaseline(item)], { concurrency: 2 }).pipe(
        Effect.tap(([agentRun, baselineRun]) =>
          Console.log(
            [agentRun, baselineRun]
              .map(
                (run) =>
                  `${item.id.padEnd(32)} ${run.arm.padEnd(8)} ${run.error === undefined ? `ok  ${run.seconds.toFixed(0)} s  $${run.cost.toFixed(4)}  ${run.calls} call(s)` : `FAIL ${run.error.slice(0, 120)}`}`,
              )
              .join("\n"),
          ),
        ),
      ),
    { concurrency: 3 },
  );

  const sheet = [
    "# Blind sheet: which set of options is better?",
    "",
    "Each case is a creative brief from one of Isaac's projects, answered twice. Set A and set B come from two different methods; which is which is kept in a separate file, and the sides are random per case. Read the brief, read both sets, then fill the ballot at the end: A, B or tie per case, plus the single option you would actually use.",
    "",
    "Judge on: would you have thought of it yourself, does it fit this project and not any project, and is it something you could use.",
    "",
  ];
  const key: Record<string, Record<string, unknown>> = {};
  for (const [index, item] of cases.entries()) {
    const pair = [...results[index]!];
    if (Math.random() < 0.5) pair.reverse();
    const sides = pair.map((run, side) => ({ label: side === 0 ? "A" : "B", run }));
    key[item.id] = Object.fromEntries(
      sides.map(({ label, run }) => [
        label,
        { arm: run.arm, cost: run.cost, seconds: run.seconds, calls: run.calls, error: run.error },
      ]),
    );
    sheet.push(
      `## ${index + 1}. ${item.id}`,
      "",
      `**Kind:** ${item.input.kind}  `,
      `**Brief:** ${item.input.brief}`,
      "",
      ...(item.input.context === undefined
        ? []
        : [`**Project context:** ${item.input.context}`, ""]),
    );
    for (const { label, run } of sides) {
      sheet.push(
        `### Set ${label}`,
        "",
        run.error === undefined
          ? markdown(run.options, run.pick, run.pickWhy)
          : `(no options: ${run.error})`,
        "",
      );
    }
  }
  sheet.push(
    "## Ballot",
    "",
    "| case | A, B or tie | the option you would use (set + number) | note |",
    "|---|---|---|---|",
    ...cases.map((item, index) => `| ${index + 1}. ${item.id} | | | |`),
    "",
  );
  yield* fs.writeFileString(path.join(out, "sheet.md"), `${sheet.join("\n")}\n`);
  yield* fs.writeFileString(
    path.join(keyDir, "key.json"),
    `${JSON.stringify({ model, key }, null, 2)}\n`,
  );

  const table = [
    "| arm | cases answered | $ total | $ per run | p50 s | calls per run |",
    "|---|---|---|---|---|---|",
  ];
  for (const arm of ["agent", "baseline"] as const) {
    const rows = results.map((pair) => pair.find((run) => run.arm === arm)!);
    const ok = rows.filter((row) => row.error === undefined);
    const seconds = ok.map((row) => row.seconds).sort((a, b) => a - b);
    const cost = rows.reduce((sum, row) => sum + row.cost, 0);
    table.push(
      `| ${arm} | ${ok.length}/${rows.length} | ${cost.toFixed(4)} | ${(cost / rows.length).toFixed(4)} | ${(seconds[Math.floor(seconds.length / 2)] ?? Number.NaN).toFixed(1)} | ${(rows.reduce((sum, row) => sum + row.calls, 0) / rows.length).toFixed(1)} |`,
    );
  }
  yield* fs.writeFileString(
    path.join(keyDir, "results.md"),
    `Model: ${model}\n\n${table.join("\n")}\n`,
  );
  yield* Console.log(
    `\n${table.join("\n")}\n\njudge: ${path.join(out, "sheet.md")}\nkey:   ${path.join(keyDir, "key.json")}`,
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
