#!/usr/bin/env bun
/**
 * Score gmail triage bench runs (`atomic-agents bench gmail triage --input '{"ids": [...]}' --models a,b,c`):
 *
 *     bun domains/gmail/bench/gmail-score.ts --reference <run> <run>...
 *
 * Per run: model, verdict counts, agreement with Isaac's answer key, agreement with the reference run,
 * cost. The key is Isaac's Catch Up notes on Gmail cards (`catchup-notes.jsonl` under Eva's Nova dir,
 * `source: "gmail"`, `cardId: "gmail:<Message-ID>"`, `verdict`); the coverage line says how much exists.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Console, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { EventBus, Home, lifecycle } from "../../../src/core/Event.ts"

/** The fields of gmail's events this score reads (the agent file, `domains/gmail/gmail.json`, declares them in full). */
const Verdict = Schema.Literals(["needs_isaac", "fyi", "noise"])
const Triaged = Schema.Struct({ id: Schema.String, from: Schema.String, subject: Schema.String, verdict: Verdict })
const Completed = Schema.Struct({ modelCalls: Schema.Int, cost: Schema.Number })
const Note = Schema.Struct({ source: Schema.String, cardId: Schema.optional(Schema.String), verdict: Schema.optional(Schema.String) })
const decodeNote = Schema.decodeUnknownOption(Schema.fromJsonString(Note))
const decodeTriaged = Schema.decodeUnknownOption(Triaged)
const decodeCompleted = Schema.decodeUnknownOption(Completed)
const isVerdict = Schema.is(Verdict)

const program = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const args = process.argv.slice(2)
  const referenceAt = args.indexOf("--reference")
  const reference = referenceAt >= 0 ? args[referenceAt + 1] : undefined
  const runs = args.filter((_, index) => index !== referenceAt && index !== referenceAt + 1)
  if (reference !== undefined && !runs.includes(reference)) runs.unshift(reference)

  const eva = yield* Config.String("EVA_ROOT").pipe(Config.withDefault(path.join(yield* Config.String("HOME"), "Eva")))
  const notesFile = path.join(eva, "work", "eva", "agents", "nova", "catchup-notes.jsonl")
  const notes = (yield* fs.readFileString(notesFile)).split("\n").flatMap((line) => Option.toArray(decodeNote(line)))
  const bySource = new Map<string, number>()
  for (const note of notes) bySource.set(note.source, (bySource.get(note.source) ?? 0) + 1)
  const key = new Map(notes.flatMap((note) =>
    note.source === "gmail" && note.cardId?.startsWith("gmail:") && isVerdict(note.verdict) ? [[note.cardId.slice("gmail:".length), note.verdict] as const] : []))
  yield* Console.log(`answer key: ${key.size} Gmail verdicts from ${notes.length} Catch Up notes (${[...bySource].map(([source, n]) => `${source} ${n}`).join(", ")})`)

  const history = yield* (yield* EventBus).history
  const results = runs.map((run) => {
    const events = history.filter((event) => event.run === run)
    const started = events.flatMap((event) => Option.toArray(lifecycle(event))).find((event) => event._tag === "job.started")
    const verdicts = new Map(events.flatMap((event) => event.type === "gmail/message.triaged" ? Option.toArray(decodeTriaged(event.data)).map((data) => [data.id, data.verdict] as const) : []))
    const completed = events.flatMap((event) => event.type === "gmail/triage.completed" ? Option.toArray(decodeCompleted(event.data)) : [])[0]
    return { run, model: started?._tag === "job.started" ? started.model : "?", verdicts, cost: completed?.cost ?? Number.NaN, calls: completed?.modelCalls ?? 0 }
  })
  const referenceVerdicts = results.find((result) => result.run === reference)?.verdicts
  const agreement = (verdicts: ReadonlyMap<string, string>, against: ReadonlyMap<string, string> | undefined) => {
    const shared = [...verdicts].filter(([id]) => against?.has(id) === true)
    const agree = shared.filter(([id, verdict]) => against?.get(id) === verdict).length
    return shared.length === 0 ? "n/a" : `${((agree / shared.length) * 100).toFixed(0)}% (${agree}/${shared.length})`
  }
  yield* Console.log(`reference: ${reference === undefined ? "none" : `${reference} (${results.find((result) => result.run === reference)?.model})`}\n`)
  yield* Console.log(["model".padEnd(30), "msgs", "needs/fyi/noise", "vs key".padEnd(12), "vs reference".padEnd(14), "calls", "cost $", "$/msg"].join("  "))
  for (const result of results) {
    const counts = ["needs_isaac", "fyi", "noise"].map((verdict) => [...result.verdicts.values()].filter((v) => v === verdict).length).join("/")
    yield* Console.log([
      result.model.padEnd(30),
      String(result.verdicts.size).padStart(4),
      counts.padEnd(15),
      agreement(result.verdicts, key).padEnd(12),
      (result.run === reference ? "(reference)" : agreement(result.verdicts, referenceVerdicts)).padEnd(14),
      String(result.calls).padStart(5),
      result.cost.toFixed(4).padStart(6),
      (result.cost / Math.max(1, result.verdicts.size)).toFixed(5)
    ].join("  "))
  }
  // Where the cheap arms part from the reference: the cases to read before trusting the agreement number.
  if (referenceVerdicts !== undefined) {
    const triaged = new Map(history.flatMap((event) => event.run === reference ? Option.toArray(decodeTriaged(event.data)).map((data) => [data.id, data] as const) : []))
    yield* Console.log("\ndisagreements with the reference:")
    for (const result of results.filter((candidate) => candidate.run !== reference)) {
      for (const [id, verdict] of result.verdicts) {
        const ref = triaged.get(id)
        if (ref !== undefined && ref.verdict !== verdict) yield* Console.log(`  ${result.model}: ${verdict} vs ${ref.verdict}  ${ref.from}: ${ref.subject.slice(0, 70)}`)
      }
    }
  }
})

program.pipe(
  Effect.provide(EventBus.layer.pipe(Layer.provideMerge(Home.layer), Layer.provideMerge(BunServices.layer))),
  BunRuntime.runMain
)
