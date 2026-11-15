#!/usr/bin/env bun
/**
 * web-researcher bake-off against an answer key of research questions with known answers:
 *
 *     bun src/bench/web-researcher.ts <dir with cases.json> [--models a,b] [--tool-modes tools,code] [--judge model] [--out dir]
 *
 * cases.json: `[{id, question, platforms?, depth?, answer, accept, evidence, source}]`. Each arm (a model in a tool mode;
 * the models cross the tool modes, default the mode in force) answers every question through the chef as shipped
 * (`Chef.cook`: the tool loop on the research pack, or in tool mode `code` one script per turn against it, `CodeMode.ts`;
 * then the `research.citations` check), no bus, nothing in the journal. Per arm:
 * - correct: a judge model compares the answer with the key (`accept` says what counts): yes 1, partial 0.5, no 0;
 * - verified: citations whose quote the check found on the page (or, for a page that would not open, its search excerpt);
 * - supported: verified citations the judge says back the answer; grounded: answers with at least one;
 * - route: which source answered (primary, platform, fallback; see the research pack);
 * - cost and seconds per answer, model calls per answer, failures.
 * Every answer lands in `<out>/<model>/<tool mode>/<case>.json`, the tables in `<out>/results.md` and `results.json` (each arm with its model and toolMode).
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Clock, Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { Adapters } from "../Adapter.ts"
import { packs } from "../adapters/index.ts"
import { Chefs } from "../Chef.ts"
import { EventBus, Home } from "../Event.ts"
import { ToolMode } from "../Component.ts"
import { ModelRunner } from "../Model.ts"
import { effective, Settings } from "../Settings.ts"

const Case = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  platforms: Schema.optionalKey(Schema.Array(Schema.String)),
  depth: Schema.optionalKey(Schema.String),
  answer: Schema.String,
  accept: Schema.String
})
type Case = typeof Case.Type
const decodeCases = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Case)))

const Citation = Schema.Struct({ url: Schema.String, quote: Schema.String, verified: Schema.Boolean, checked: Schema.String, via: Schema.String })
const Answered = Schema.Struct({ answer: Schema.String, citations: Schema.Array(Citation), route: Schema.String, toolCalls: Schema.Record(Schema.String, Schema.Number) })
type Answered = typeof Answered.Type
const decodeAnswered = Schema.decodeUnknownEffect(Answered)
const Verdict = Schema.Struct({ correct: Schema.Literals(["yes", "partial", "no"]), supports: Schema.Array(Schema.Boolean), why: Schema.String })
type Verdict = typeof Verdict.Type
const decodeVerdict = Schema.decodeUnknownOption(Schema.fromJsonString(Verdict))
const SCORE: Readonly<Record<Verdict["correct"], number>> = { yes: 1, partial: 0.5, no: 0 }

interface Outcome {
  readonly item: Case
  readonly answered: Answered | undefined
  readonly verdict: Verdict | undefined
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
  if (dir === undefined) return yield* Effect.fail(new Error("usage: web-researcher.ts <dir with cases.json> [--models a,b] [--tool-modes tools,code] [--judge model] [--out dir]"))
  const chef = (yield* (yield* Chefs).current).find((candidate) => candidate.id === "web-researcher")
  if (chef?.cook === undefined) return yield* Effect.fail(new Error("no web-researcher recipe chef loaded"))
  const cook = chef.cook
  const resolved = effective(chef, yield* (yield* Settings).current).agent
  const models = flag("models")?.split(",") ?? resolved.candidates
  const judge = flag("judge") ?? "anthropic/claude-opus-5-5"
  const toolModes = yield* Schema.decodeUnknownEffect(Schema.Array(ToolMode))(flag("tool-modes")?.split(",") ?? [resolved.toolMode ?? "tools"])
  const arms = models.flatMap((model) => toolModes.map((toolMode) => ({ model, toolMode, label: `${model} [${toolMode}]` })))
  const root = path.resolve(dir)
  const cases = yield* decodeCases(yield* fs.readFileString(path.join(root, "cases.json")))
  const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().slice(0, 16).replace(/[-:]/g, "")
  const out = path.resolve(flag("out") ?? path.join(root, "runs", stamp))
  const runner = yield* ModelRunner
  yield* Console.log(`${cases.length} questions on ${arms.map(({ label }) => label).join(", ")}; judge ${judge}; out ${out}\n`)

  const grade = (item: Case, answered: Answered) =>
    runner.generate({
      model: judge,
      system: "You grade a research answer against an answer key. Answer one JSON object and nothing else.",
      prompt: [
        `Question: ${item.question}`,
        `Answer key: ${item.answer}`,
        `What counts as correct: ${item.accept}`,
        "",
        `The answer to grade: ${answered.answer}`,
        "Its citations (quotes copied from the cited pages):",
        ...answered.citations.map((citation, index) => `${index + 1}. ${citation.url}: "${citation.quote}"`),
        "",
        `correct: "yes" when it has every essential fact the key requires and nothing the key calls wrong, "partial" when some essentials are missing but nothing is wrong, else "no".`,
        `supports: one boolean per citation, in order: does that quote, on its own, back a claim the answer makes?`,
        `Answer {"correct": "yes" | "partial" | "no", "supports": [true, ...], "why": "<one sentence>"}.`
      ].join("\n"),
      timeout: "2 minutes"
    }).pipe(
      Effect.map((reply) => Option.getOrUndefined(decodeVerdict(reply.text.slice(reply.text.indexOf("{"), reply.text.lastIndexOf("}") + 1)))),
      Effect.orElseSucceed(() => undefined)
    )

  const answer = (model: string, toolMode: ToolMode, item: Case) =>
    Effect.gen(function*() {
      const runDir = path.join(out, model.replaceAll("/", "_"), toolMode, item.id)
      yield* fs.makeDirectory(runDir, { recursive: true })
      const context = { component: "web-researcher", job: "answer", run: "bench", runDir, stateDir: runDir, model, toolMode, agent: { ...resolved, model, toolMode } }
      const input = { question: item.question, ...(item.platforms ? { platforms: item.platforms } : {}), ...(item.depth ? { depth: item.depth } : {}) }
      const result = yield* cook.item(input, context)
      const answered = yield* decodeAnswered(result.fields)
      const verdict = yield* grade(item, answered)
      yield* fs.writeFileString(`${runDir}.json`, `${JSON.stringify({ input, toolMode, ...result, verdict }, null, 2)}\n`)
      yield* fs.remove(runDir, { recursive: true })
      const outcome: Outcome = { item, answered, verdict, cost: result.cost, seconds: result.seconds, attempts: result.attempts }
      return outcome
    }).pipe(Effect.catch((error) =>
      Effect.succeed<Outcome>({ item, answered: undefined, verdict: undefined, cost: 0, seconds: 0, attempts: 0, error: String("message" in error ? error.message : error) })))

  const results = yield* Effect.forEach(arms, ({ model, toolMode, label }) =>
    Effect.forEach(cases, (item) =>
      answer(model, toolMode, item).pipe(Effect.tap((outcome) => {
        const cited = outcome.answered?.citations ?? []
        return Console.log(`${label.padEnd(36)} ${item.id.padEnd(34)} ${outcome.error ? `FAIL ${outcome.error.slice(0, 80)}` : `${outcome.verdict?.correct ?? "?"}  verified ${cited.filter((citation) => citation.verified).length}/${cited.length}  ${outcome.answered?.route}  ${outcome.seconds.toFixed(0)} s`}`)
      })), { concurrency: 2 }).pipe(Effect.map((rows) => ({ model, toolMode, label, rows }))), { concurrency: "unbounded" })

  const table = [
    "| arm | correct | citations verified | verified and supporting | grounded answers | $/answer | p50 s | p95 s | calls/answer | routes | failures |",
    "|---|---|---|---|---|---|---|---|---|---|---|"
  ]
  for (const { label, rows } of results) {
    const done = rows.filter((row) => row.answered !== undefined)
    const graded = done.flatMap((row) => row.verdict === undefined ? [] : [row])
    const citations = done.flatMap((row) => row.answered!.citations.map((citation, index) => ({ citation, supports: row.verdict?.supports[index] === true })))
    const verified = citations.filter(({ citation }) => citation.verified)
    const supporting = verified.filter(({ supports }) => supports)
    const grounded = done.filter((row) => row.answered!.citations.some((citation, index) => citation.verified && row.verdict?.supports[index] === true))
    const routes = new Map<string, number>()
    for (const row of done) routes.set(row.answered!.route, (routes.get(row.answered!.route) ?? 0) + 1)
    const correct = graded.reduce((sum, row) => sum + SCORE[row.verdict!.correct], 0)
    table.push(`| ${label} | ${correct}/${rows.length} | ${verified.length}/${citations.length} | ${supporting.length}/${citations.length} | ${grounded.length}/${rows.length} | ${(done.reduce((sum, row) => sum + row.cost, 0) / Math.max(1, done.length)).toFixed(4)} | ${percentile(done.map((row) => row.seconds), 0.5).toFixed(1)} | ${percentile(done.map((row) => row.seconds), 0.95).toFixed(1)} | ${(done.reduce((sum, row) => sum + row.attempts, 0) / Math.max(1, done.length)).toFixed(1)} | ${[...routes].map(([route, count]) => `${route} ${count}`).join(", ")} | ${rows.length - done.length} |`)
  }
  const perCase = [`| case | ${results.map(({ model, toolMode }) => `${model.split("/").at(-1)} ${toolMode}`).join(" | ")} |`, `|---|${results.map(() => "---|").join("")}`]
  for (const item of cases) {
    perCase.push(`| ${item.id} | ${results.map(({ rows }) => {
      const row = rows.find((candidate) => candidate.item.id === item.id)!
      if (row.answered === undefined) return "fail"
      const cited = row.answered.citations
      return `${row.verdict?.correct ?? "?"} ${cited.filter((citation) => citation.verified).length}/${cited.length} ${row.answered.route}`
    }).join(" | ")} |`)
  }
  const failures = results.flatMap(({ label, rows }) => rows.flatMap((row) => row.error === undefined ? [] : [`- ${label} ${row.item.id}: ${row.error}`]))
  const report = [
    `# web-researcher bench ${stamp}`,
    "",
    `${cases.length} questions from ${path.join(root, "cases.json")}; judge: ${judge}.`,
    "correct: the judge's verdict against the key (yes 1, partial 0.5). verified: citations whose quote the check found on the page (or its search excerpt when the page would not open). supporting: verified and the judge says the quote backs the answer. grounded: answers with at least one verified, supporting citation. routes: which source answered (primary = web search + reader; platform and fallback = agent-reach).",
    "",
    ...table,
    "",
    "Per case (verdict, verified/cited, route):",
    "",
    ...perCase,
    ...(failures.length === 0 ? [] : ["", "Failures:", ...failures])
  ].join("\n")
  yield* fs.writeFileString(path.join(out, "results.md"), `${report}\n`)
  yield* fs.writeFileString(path.join(out, "results.json"), `${JSON.stringify(results.map(({ model, toolMode, rows }) => ({ model, toolMode, rows: rows.map(({ item, ...row }) => ({ id: item.id, ...row })) })), null, 2)}\n`)
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
