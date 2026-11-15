#!/usr/bin/env bun
/**
 * Widget bake-off against the answer key in `cases.json` (real drafts from Isaac's assistant threads):
 *
 *     bun src/components/widget/bench.ts [--models a,b,c] [--repeat 2]
 *
 * Calls `decide` directly (no bus, nothing in the journal), every model on every case; models run side by
 * side, cases one after another. Per model: right kind (none, or a block holding every expected
 * component), renders (Relay's parser; first try, and after the one repair), p50/p95 seconds, cost.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { parseOpenUI } from "@evaos/chat-core/openui"
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { builtins } from "../../builtins.ts"
import { Components } from "../../Component.ts"
import { EventBus, Home } from "../../Event.ts"
import { ModelRunner } from "../../Model.ts"
import { effective, Settings } from "../../Settings.ts"
import { decide, renderErrors, widget } from "./component.ts"

const Case = Schema.Struct({
  id: Schema.String,
  /** Where the draft comes from: `<session file>:<line>`. */
  source: Schema.String,
  draft: Schema.String,
  data: Schema.optionalKey(Schema.Json),
  surface: Schema.Literals(["phone", "desktop"]),
  /** Widget keys the block must hold (`recipe`, `tabs`+`code`, ...); empty means the answer is none. */
  expect: Schema.Array(Schema.String),
  note: Schema.optionalKey(Schema.String)
})
const decodeCases = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Case)))

/** Every `widget` key in a parsed tree. */
const widgets = (node: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(node)) for (const child of node) widgets(child, out)
  else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "widget" && typeof value === "string") out.add(value)
      else widgets(value, out)
    }
  }
  return out
}

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
  const cases = yield* decodeCases(yield* fs.readFileString(path.join(import.meta.dir, "cases.json")))
  yield* Console.log(`${cases.length} cases x ${repeat} on ${models.join(", ")}\n`)

  const results = yield* Effect.forEach(models, (model) =>
    Effect.forEach(Array.from({ length: repeat }, (_, round) => round).flatMap((round) => cases.map((item) => ({ round, item }))), ({ item }) =>
      decide({ model, system: resolved.system, ...(resolved.thinking ? { thinking: resolved.thinking } : {}) }, {
        draft: item.draft,
        surface: item.surface,
        ...(item.data === undefined ? {} : { data: item.data })
      }).pipe(
        Effect.map((decision) => {
          const body = decision.answer.block?.replace(/^```openui\n/, "").replace(/\n```$/, "")
          const found = body === undefined ? new Set<string>() : widgets(parseOpenUI(body).node)
          const right = item.expect.length === 0 ? decision.answer.kind === "none" : item.expect.every((kind) => found.has(kind))
          return { model, item, decision, found: [...found], right, renders: body === undefined || renderErrors(body).length === 0, error: undefined }
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
