#!/usr/bin/env bun
/**
 * Bake-off for the ecard-* chefs against the real cases in `<home>/bench/<chef>/cases.json`
 * (`[{id, input, expect}]`, built from history; scores in `ecard-score.ts`):
 *
 *     bun src/bench/ecard.ts <chef> [--models a,b] [--tool-modes tools,code] [--concurrency 4]
 *
 * Calls the chef's model stage (`Chef.cook`: steps, model with its real read-only tools) directly (no bus, nothing
 * in the journal), once per arm: each model in each tool mode (`--tool-modes`, a chef with tools only; default the
 * mode in force). Per arm: right/total, partial hits where the score has them, p50 seconds, $/case, errors; then
 * per case. Writes every answer (with its model and toolMode) to `<home>/bench/<chef>/results-<stamp>.json`.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Clock, Console, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Adapters } from "../Adapter.ts"
import { packs } from "../adapters/index.ts"
import { Chefs } from "../Chef.ts"
import { ToolMode } from "../Component.ts"
import { EventBus, Home } from "../Event.ts"
import { ModelRunner } from "../Model.ts"
import { effective, Settings } from "../Settings.ts"
import { type Score, scorers } from "./ecard-score.ts"

const Case = Schema.Struct({ id: Schema.String, input: Schema.Record(Schema.String, Schema.Unknown), expect: Schema.Unknown })
const decodeCases = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Case)))

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`)
    return at < 0 ? undefined : args[at + 1]
  }
  const id = args[0] ?? ""
  const scorer = scorers[id]
  const chef = (yield* (yield* Chefs).current).find((candidate) => candidate.id === id)
  if (scorer === undefined || chef?.cook === undefined) return yield* Console.error(`usage: bench/ecard.ts <${Object.keys(scorers).join("|")}> [--models a,b] [--tool-modes tools,code]`)
  const cook = chef.cook
  const resolved = effective(chef, yield* (yield* Settings).current).agent
  const models = flag("models")?.split(",") ?? resolved.candidates
  const asked = flag("tool-modes")
  if (asked !== undefined && resolved.toolMode === undefined) return yield* Console.error(`${id} calls no tools, so it has no tool modes to compare`)
  const toolModes = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.UndefinedOr(ToolMode)))(asked?.split(",") ?? [resolved.toolMode])
  const arms = models.flatMap((model) => toolModes.map((toolMode) => ({ model, toolMode, label: toolMode === undefined ? model : `${model} [${toolMode}]` })))
  const dir = path.join((yield* Home).root, "bench", id)
  const cases = yield* decodeCases(yield* fs.readFileString(path.join(dir, "cases.json")))
  yield* Console.log(`${id}: ${cases.length} cases on ${arms.map(({ label }) => label).join(", ")}\n`)

  const results = yield* Effect.forEach(arms, ({ model, toolMode, label }) =>
    Effect.forEach(cases, (item) =>
      Effect.gen(function*() {
        const modes = toolMode === undefined ? {} : { toolMode }
        const result = yield* cook.item(item.input, { component: id, job: chef.jobs[0]!.id, run: "bench", runDir: "", stateDir: "", model, ...modes, agent: { ...resolved, model, ...modes } })
        const answer = yield* Schema.decodeUnknownEffect(scorer.answer)(result.fields)
        const score = scorer.score(yield* Schema.decodeUnknownEffect(scorer.expect)(item.expect), answer, item.input)
        return { model, toolMode, label, id: item.id, answer: result.fields as unknown, cost: result.cost as number | undefined, seconds: result.seconds as number | undefined, score, error: undefined as string | undefined }
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ model, toolMode, label, id: item.id, answer: undefined, cost: undefined, seconds: undefined, score: { right: false, note: "error" } as Score, error: error.message as string | undefined }))
      ), { concurrency: Number(flag("concurrency") ?? "4") }), { concurrency: "unbounded" })

  const p50 = (values: ReadonlyArray<number>) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN
  yield* Console.log(["arm".padEnd(38), "right", "hits", "p50 s", "$/case", "errors"].join("  "))
  for (const rows of results) {
    const done = rows.filter((row) => row.error === undefined)
    const partial = rows.some((row) => row.score.total !== undefined)
    yield* Console.log([
      rows[0]!.label.padEnd(38),
      `${rows.filter((row) => row.score.right).length}/${rows.length}`.padStart(5),
      (partial ? `${rows.reduce((sum, row) => sum + (row.score.hits ?? 0), 0)}/${rows.reduce((sum, row) => sum + (row.score.total ?? 0), 0)}` : "-").padStart(5),
      p50(done.map((row) => row.seconds ?? 0)).toFixed(1).padStart(5),
      (done.reduce((sum, row) => sum + (row.cost ?? 0), 0) / Math.max(1, done.length)).toFixed(4).padStart(6),
      String(rows.length - done.length).padStart(6)
    ].join("  "))
  }
  yield* Console.log("\nper case (✓ right, ✗ wrong):")
  for (const item of cases) {
    yield* Console.log(`  ${item.id}  expect ${JSON.stringify(item.expect).slice(0, 100)}`)
    for (const rows of results) {
      const row = rows.find((candidate) => candidate.id === item.id)!
      yield* Console.log(`    ${row.score.right ? "✓" : "✗"} ${row.label.padEnd(38)} ${row.error === undefined ? row.score.note : `error: ${row.error.slice(0, 100)}`}`)
    }
  }
  const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().replace(/[:.]/g, "-")
  const out = path.join(dir, `results-${stamp}.json`)
  yield* fs.writeFileString(out, `${JSON.stringify(results.flat(), null, 1)}\n`)
  yield* Console.log(`\nanswers: ${out}`)
})

program.pipe(
  Effect.provide(ModelRunner.omp.pipe(
    Layer.provideMerge(Settings.layer),
    Layer.provideMerge(Chefs.layer),
    Layer.provideMerge(Adapters.make(packs)),
    Layer.provideMerge(EventBus.layer),
    Layer.provideMerge(Home.layer),
    Layer.provideMerge(BunServices.layer)
  )),
  BunRuntime.runMain
)
