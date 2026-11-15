#!/usr/bin/env bun
/**
 * design-critic bake-off against an answer key of past UIs with Isaac's known verdict:
 *
 *     bun src/bench/design-critic.ts <dir with cases.json> [--models a,b] [--judge model] [--out dir]
 *
 * cases.json: `[{id, intent, images: {<side>: png}, html?: {<side>: file}, url?: {<side>: url}, viewport?, better: <side>,
 * topIssue, source}]`, two sides per case (before/after, or two variants). Each model critiques every side through the chef as
 * shipped (`browser.screenshot` source, then `Chef.cook`: model and the `ui-check.evidence` check), no bus, nothing in
 * the journal: a side with html or a url is rendered and measured, else its screenshot is used as is. Per model:
 * - agree: the side Isaac judged better scores higher (a tie counts half);
 * - issue: a judge model says whether one of the critique's first three findings on the worse side is the problem Isaac named;
 * - measured: of the findings on measurable rules (rendered sides only), how many ui-check confirmed;
 * - cost and seconds per critique, failures.
 * Every critique lands in `<out>/<model>/<case>-<side>.json`, the table in `<out>/results.md`.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Clock, Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Adapters } from "../Adapter.ts"
import { packs } from "../adapters/index.ts"
import { Chefs } from "../Chef.ts"
import { EventBus, Home } from "../Event.ts"
import { ModelRunner } from "../Model.ts"
import { effective, Settings } from "../Settings.ts"

const Sides = Schema.Record(Schema.String, Schema.String)
const Case = Schema.Struct({
  id: Schema.String,
  intent: Schema.String,
  images: Sides,
  html: Schema.optionalKey(Sides),
  url: Schema.optionalKey(Sides),
  viewport: Schema.optionalKey(Schema.Number),
  better: Schema.String,
  topIssue: Schema.String,
  source: Schema.String
})
type Case = typeof Case.Type
const decodeCases = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Case)))

const Finding = Schema.Struct({ rule: Schema.String, element: Schema.String, fix: Schema.String, severity: Schema.String, measured: Schema.optionalKey(Schema.Boolean) })
const Critique = Schema.Struct({ score: Schema.Number, findings: Schema.Array(Finding), summary: Schema.String })
type Critique = typeof Critique.Type
const decodeCritique = Schema.decodeUnknownEffect(Critique)
const decodeMatch = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ match: Schema.Boolean })))

interface Outcome {
  readonly side: string
  readonly critique: Critique | undefined
  readonly cost: number
  readonly seconds: number
  readonly attempts: number
  readonly error?: string
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
  const dir = args.find((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"))
  if (dir === undefined) return yield* Effect.fail(new Error("usage: design-critic.ts <dir with cases.json> [--models a,b] [--judge model] [--out dir]"))
  const critic = (yield* (yield* Chefs).current).find((chef) => chef.id === "design-critic")
  if (critic?.cook === undefined) return yield* Effect.fail(new Error("no design-critic recipe chef loaded"))
  const cook = critic.cook
  const source = (yield* Adapters).sources.get("browser.screenshot")
  if (source === undefined) return yield* Effect.fail(new Error("no browser.screenshot source adapter"))
  const resolved = effective(critic, yield* (yield* Settings).current).agent
  const models = flag("models")?.split(",") ?? resolved.candidates
  const judge = flag("judge") ?? "anthropic/claude-opus-5-5"
  const root = path.resolve(dir)
  const cases = yield* decodeCases(yield* fs.readFileString(path.join(root, "cases.json")))
  const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().slice(0, 16).replace(/[-:]/g, "")
  const out = path.resolve(flag("out") ?? path.join(root, "runs", stamp))
  const runner = yield* ModelRunner
  yield* Console.log(`${cases.length} cases x 2 sides on ${models.join(", ")}; judge ${judge}; out ${out}\n`)

  const critique = (model: string, item: Case, side: string) =>
    Effect.gen(function*() {
      const runDir = path.join(out, model.replaceAll("/", "_"), `${item.id}-${side}`)
      yield* fs.makeDirectory(runDir, { recursive: true })
      const context = { component: "design-critic", job: "critique", run: "bench", runDir, stateDir: runDir, model, agent: { ...resolved, model } }
      const html = item.html?.[side]
      const url = item.url?.[side] ?? (html === undefined ? undefined : `file://${path.resolve(root, html)}`)
      // A neutral name: the model must not read "before" or "after" off the file.
      const image = path.resolve(root, item.images[side]!)
      const shot = path.join(runDir, `shot${path.extname(image)}`)
      if (url === undefined) yield* fs.copyFile(image, shot)
      const input = {
        intent: item.intent,
        ...(url === undefined ? { screenshot: shot } : { url }),
        ...(item.viewport === undefined ? {} : { viewports: [item.viewport] })
      }
      const batch = yield* source.fetch(input, context)
      const result = yield* cook.item({ ...input, ...batch.items[0]!.fields }, context)
      const parsed = yield* decodeCritique(result.fields)
      yield* fs.writeFileString(path.join(runDir, "critique.json"), `${JSON.stringify({ input, ...result }, null, 2)}\n`)
      const outcome: Outcome = { side, critique: parsed, cost: result.cost, seconds: result.seconds, attempts: result.attempts }
      return outcome
    }).pipe(Effect.catch((error) => Effect.succeed<Outcome>({ side, critique: undefined, cost: 0, seconds: 0, attempts: 0, error: String("message" in error ? error.message : error) })))

  const issueMatch = (item: Case, critique: Critique) =>
    runner.generate({
      model: judge,
      system: "You compare a design critique with the problem a designer named. Answer one JSON object and nothing else.",
      prompt: [
        `The designer's main problem with this screen: ${item.topIssue}`,
        "The critique's first three findings:",
        ...critique.findings.slice(0, 3).map((finding, index) => `${index + 1}. [${finding.rule}] ${finding.element}: ${finding.fix}`),
        `Does one of these findings name the same problem (same element or area and the same kind of fault, in any words)? Answer {"match": true} or {"match": false}.`
      ].join("\n"),
      timeout: "2 minutes"
    }).pipe(
      Effect.map((reply) => Option.getOrElse(Option.map(decodeMatch(reply.text.slice(reply.text.indexOf("{"), reply.text.lastIndexOf("}") + 1)), (answer) => answer.match), () => false)),
      Effect.orElseSucceed(() => false)
    )

  const results = yield* Effect.forEach(models, (model) =>
    Effect.forEach(cases, (item) =>
      Effect.gen(function*() {
        const sides = yield* Effect.forEach(Object.keys(item.images), (side) => critique(model, item, side), { concurrency: 2 })
        const better = sides.find((entry) => entry.side === item.better)
        const worse = sides.find((entry) => entry.side !== item.better)
        const agree = better?.critique === undefined || worse?.critique === undefined
          ? undefined
          : better.critique.score > worse.critique.score ? 1 : better.critique.score === worse.critique.score ? 0.5 : 0
        const issue = worse?.critique === undefined ? undefined : yield* issueMatch(item, worse.critique)
        yield* Console.log(`${model.padEnd(28)} ${item.id.padEnd(28)} ${sides.map((entry) => `${entry.side} ${entry.critique?.score ?? "FAIL"}`).join("  ")}  agree ${agree ?? "-"}  issue ${issue ?? "-"}`)
        return { item, sides, agree, issue }
      }), { concurrency: 2 }).pipe(Effect.map((rows) => ({ model, rows }))), { concurrency: "unbounded" })

  const table = [
    "| model | agree | issue (top 3) | measured confirmed | $/critique | p50 s | p95 s | calls/critique | failures |",
    "|---|---|---|---|---|---|---|---|---|"
  ]
  for (const { model, rows } of results) {
    const outcomes = rows.flatMap((row) => row.sides)
    const done = outcomes.filter((entry) => entry.critique !== undefined)
    const agreed = rows.flatMap((row) => row.agree === undefined ? [] : [row.agree])
    const issues = rows.flatMap((row) => row.issue === undefined ? [] : [row.issue])
    const measured = done.flatMap((entry) => entry.critique!.findings.flatMap((finding) => finding.measured === undefined ? [] : [finding.measured]))
    const seconds = done.map((entry) => entry.seconds)
    const cost = done.reduce((sum, entry) => sum + entry.cost, 0) / Math.max(1, done.length)
    table.push(`| ${model} | ${agreed.reduce((a, b) => a + b, 0)}/${agreed.length} | ${issues.filter(Boolean).length}/${issues.length} | ${measured.filter(Boolean).length}/${measured.length} | ${cost.toFixed(4)} | ${percentile(seconds, 0.5).toFixed(1)} | ${percentile(seconds, 0.95).toFixed(1)} | ${(done.reduce((sum, entry) => sum + entry.attempts, 0) / Math.max(1, done.length)).toFixed(2)} | ${outcomes.length - done.length} |`)
  }
  const perCase = ["| case | better | " + results.map(({ model }) => model.split("/").at(-1)).join(" | ") + " |", `|---|---|${results.map(() => "---|").join("")}`]
  for (const item of cases) {
    perCase.push(`| ${item.id} | ${item.better} | ${results.map(({ rows }) => {
      const row = rows.find((candidate) => candidate.item.id === item.id)!
      return `${row.sides.map((entry) => `${entry.side[0]} ${entry.critique?.score ?? "x"}`).join(" / ")} ${row.agree === 1 ? "✓" : row.agree === 0.5 ? "=" : "✗"}${row.issue ? " ●" : ""}`
    }).join(" | ")} |`)
  }
  const failures = results.flatMap(({ model, rows }) => rows.flatMap((row) => row.sides.flatMap((entry) => entry.error === undefined ? [] : [`- ${model} ${row.item.id} ${entry.side}: ${entry.error}`])))
  const report = [
    `# design-critic bench ${stamp}`,
    "",
    `${cases.length} cases from ${path.join(root, "cases.json")}; judge for issue matches: ${judge}.`,
    "agree: the side Isaac judged better scored higher (tie = half). issue: one of the first three findings on the worse side is the problem he named. measured: findings on measurable rules that ui-check confirmed (rendered sides only). calls/critique: model calls per critique (1 = no JSON retry or repair).",
    "",
    ...table,
    "",
    "Per case (scores per side; ✓ agrees, = tie, ✗ disagrees, ● top issue found):",
    "",
    ...perCase,
    ...(failures.length === 0 ? [] : ["", "Failures:", ...failures])
  ].join("\n")
  yield* fs.writeFileString(path.join(out, "results.md"), `${report}\n`)
  yield* fs.writeFileString(path.join(out, "results.json"), `${JSON.stringify(results.map(({ model, rows }) => ({ model, rows: rows.map((row) => ({ id: row.item.id, agree: row.agree, issue: row.issue, sides: row.sides })) })), null, 2)}\n`)
  yield* Console.log(`\n${table.join("\n")}\n\nwritten ${path.join(out, "results.md")}`)
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
