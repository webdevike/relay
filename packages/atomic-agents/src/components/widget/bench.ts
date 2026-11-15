#!/usr/bin/env bun
/**
 * Widget bake-off against the answer key in `cases.json` (real drafts from Isaac's assistant threads) plus his
 * 🎯 answers from Relay (`<home>/bench/widget/training.jsonl`, see `cases.ts`):
 *
 *     bun src/components/widget/bench.ts [--models a,b,c] [--repeat 2]
 *
 * Calls `decide` directly (no bus, nothing in the journal), every model on every case; models run side by
 * side, cases one after another. Per model: right kind (none, or a block holding every expected
 * component), renders (Relay's parser; first try, and after the one repair), p50/p95 seconds, cost.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { builtins } from "../../builtins.ts"
import { Components } from "../../Component.ts"
import { EventBus, Home } from "../../Event.ts"
import { ModelRunner } from "../../Model.ts"
import { effective, Settings } from "../../Settings.ts"
import { Case, trainingCases, widgetKeys } from "./cases.ts"
import { decide, renderErrors, widget } from "./component.ts"

const decodeCases = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Case)))

const percentile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN
}

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`)
    return at < 0 ? undefined : args[at + 1]
  }
  const resolved = effective(widget, yield* (yield* Settings).current).agent
  const models = flag("models")?.split(",") ?? resolved.candidates
  const repeat = Number(flag("repeat") ?? "1")
  const keyed = yield* decodeCases(yield* fs.readFileString(path.join(import.meta.dir, "cases.json")))
  const trainingFile = path.join((yield* Home).root, "bench", "widget", "training.jsonl")
  const trained = (yield* fs.exists(trainingFile)) ? trainingCases(yield* fs.readFileString(trainingFile)) : { cases: [], skipped: 0 }
  const cases = [...keyed, ...trained.cases]
  yield* Console.log(`${cases.length} cases (${trained.cases.length} from 🎯 in ${trainingFile}, ${trained.skipped} skipped) x ${repeat} on ${models.join(", ")}\n`)

  const results = yield* Effect.forEach(models, (model) =>
    Effect.forEach(Array.from({ length: repeat }, (_, round) => round).flatMap((round) => cases.map((item) => ({ round, item }))), ({ item }) =>
      decide({ model, system: resolved.system, ...(resolved.thinking ? { thinking: resolved.thinking } : {}) }, {
        draft: item.draft,
        surface: item.surface,
        ...(item.data === undefined ? {} : { data: item.data })
      }).pipe(
        Effect.map((decision) => {
          const body = decision.answer.block
          const found = new Set(body === undefined ? [] : widgetKeys(body))
          const right = item.expect.length === 0 ? decision.answer.kind === "none" : item.expect.every((kind) => found.has(kind))
          return { model, item, decision, found: [...found], right, renders: body === undefined || renderErrors(body.replace(/^```openui\n/, "").replace(/\n```$/, "")).length === 0, error: undefined }
        }),
        Effect.catchTag("ModelError", (error) => Effect.succeed({ model, item, decision: undefined, found: [], right: false, renders: true, error: error.message }))
      )), { concurrency: "unbounded" })

  yield* Console.log(["model".padEnd(36), "right", "renders", "1st try", "p50 s", "p95 s", "$/req", "errors"].join("  "))
  for (const rows of results) {
    const done = rows.flatMap((row) => row.decision === undefined ? [] : [row.decision])
    const blocks = rows.filter((row) => row.decision?.answer.kind === "openui")
    const firstTry = rows.filter((row) => row.decision !== undefined && !row.decision.repaired && row.decision.answer.kind === "openui").length
    const tried = rows.filter((row) => row.decision !== undefined && (row.decision.answer.kind === "openui" || row.decision.repaired)).length
    const seconds = done.map((decision) => decision.seconds)
    yield* Console.log([
      rows[0]!.model.padEnd(36),
      `${rows.filter((row) => row.right).length}/${rows.length}`.padStart(5),
      `${blocks.filter((row) => row.renders).length}/${blocks.length}`.padStart(7),
      `${firstTry}/${tried}`.padStart(7),
      percentile(seconds, 0.5).toFixed(2).padStart(5),
      percentile(seconds, 0.95).toFixed(2).padStart(5),
      (done.reduce((sum, decision) => sum + decision.cost, 0) / Math.max(1, done.length)).toFixed(5).padStart(7),
      String(rows.filter((row) => row.error !== undefined).length).padStart(6)
    ].join("  "))
  }
  yield* Console.log("\nper case (✓ right, ✗ wrong; what it answered, seconds):")
  for (const item of cases) {
    yield* Console.log(`  ${item.id} [expect ${item.expect.join("+") || "none"}]`)
    for (const rows of results) {
      for (const row of rows.filter((candidate) => candidate.item.id === item.id)) {
        const answered = row.error !== undefined ? `error: ${row.error.slice(0, 80)}` : row.found.length === 0 ? "none" : row.found.join("+")
        yield* Console.log(`    ${row.right ? "✓" : "✗"} ${row.model.padEnd(36)} ${answered.padEnd(28)} ${row.decision?.seconds.toFixed(2) ?? "-"}s${row.decision?.repaired ? " repaired" : ""}  ${row.decision?.answer.why.slice(0, 90) ?? ""}`)
      }
    }
  }
})

program.pipe(
  Effect.provide(ModelRunner.omp.pipe(
    Layer.provideMerge(Settings.layer),
    Layer.provideMerge(EventBus.layer),
    Layer.provideMerge(Home.layer),
    // Every built-in, so config.json (which names the others) validates and its openRouterKeyFile applies.
    Layer.provideMerge(Layer.succeed(Components, builtins)),
    Layer.provideMerge(BunServices.layer)
  )),
  BunRuntime.runMain
)
