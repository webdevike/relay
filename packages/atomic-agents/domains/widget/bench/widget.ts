#!/usr/bin/env bun
/**
 * Widget bake-off against the answer key in `widget-cases.json` (real drafts from Isaac's assistant threads) plus his
 * 🎯 answers from Relay (`<home>/bench/widget/training.jsonl`, see `widget-cases.ts`):
 *
 *     bun domains/widget/bench/widget.ts [--models a,b,c] [--repeat 2]
 *
 * Calls the widget agent's model stage (`Agent.modelStage`: step, model, parser check) directly (no bus, nothing in the
 * journal), every model on every case; models run side by side, cases one after another. Per model: right kind
 * (none, or a block holding every expected component), renders (Relay's parser; first try, and after the one
 * repair), p50/p95 seconds, cost.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Adapters } from "../../../src/core/Adapter.ts"
import { packs } from "../../../src/packs.ts"
import { renderErrors } from "../adapters/openui.ts"
import { Agents } from "../../../src/core/Agent.ts"
import { EventBus, Home } from "../../../src/core/Event.ts"
import { ModelRunner } from "../../../src/core/Model.ts"
import { effective, Settings } from "../../../src/core/Settings.ts"
import { Case, trainingCases, widgetKeys } from "./widget-cases.ts"

const decodeCases = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Case)))
const Answer = Schema.Struct({ kind: Schema.Literals(["openui", "none"]), block: Schema.optionalKey(Schema.String), why: Schema.String })
const decodeAnswer = Schema.decodeUnknownEffect(Answer)

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
  const widget = (yield* (yield* Agents).current).find((agent) => agent.id === "widget")
  if (widget?.modelStage === undefined) return yield* Effect.fail(new Error("no widget spec agent loaded"))
  const modelStage = widget.modelStage
  const resolved = effective(widget, yield* (yield* Settings).current).agent
  const models = flag("models")?.split(",") ?? resolved.candidates
  const repeat = Number(flag("repeat") ?? "1")
  const keyed = yield* decodeCases(yield* fs.readFileString(path.join(import.meta.dir, "widget-cases.json")))
  const trainingFile = path.join((yield* Home).root, "bench", "widget", "training.jsonl")
  const trained = (yield* fs.exists(trainingFile)) ? trainingCases(yield* fs.readFileString(trainingFile)) : { cases: [], skipped: 0 }
  const cases = [...keyed, ...trained.cases]
  yield* Console.log(`${cases.length} cases (${trained.cases.length} from 🎯 in ${trainingFile}, ${trained.skipped} skipped) x ${repeat} on ${models.join(", ")}\n`)

  const results = yield* Effect.forEach(models, (model) =>
    Effect.forEach(Array.from({ length: repeat }, (_, round) => round).flatMap((round) => cases.map((item) => ({ round, item }))), ({ item }) =>
      modelStage.item({ draft: item.draft, surface: item.surface, ...(item.data === undefined ? {} : { data: item.data }) }, {
        component: "widget", job: "pick", run: "bench", runDir: "", stateDir: "", model, agent: { ...resolved, model }
      }).pipe(
        Effect.flatMap((result) =>
          Effect.map(decodeAnswer(result.fields), (answer) => ({ answer, calls: result.attempts, repaired: result.attempts > 1, cost: result.cost, seconds: result.seconds }))),
        Effect.map((decision) => {
          const body = decision.answer.block
          const found = new Set(body === undefined ? [] : widgetKeys(body))
          const right = item.expect.length === 0 ? decision.answer.kind === "none" : item.expect.every((kind) => found.has(kind))
          return { model, item, decision, found: [...found], right, renders: body === undefined || renderErrors(body.replace(/^```openui\n/, "").replace(/\n```$/, "")).length === 0, error: undefined }
        }),
        Effect.catch((error) => Effect.succeed({ model, item, decision: undefined, found: [], right: false, renders: true, error: error.message }))
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
    Layer.provideMerge(Agents.layer),
    Layer.provideMerge(Adapters.make(packs)),
    Layer.provideMerge(EventBus.layer),
    Layer.provideMerge(Home.layer),
    Layer.provideMerge(BunServices.layer)
  )),
  BunRuntime.runMain
)
