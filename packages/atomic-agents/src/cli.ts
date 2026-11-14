#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { propRender } from "./components/prop-render/component.ts"
import { type AgentEvent, EventBus, Home, makeEvent } from "./Event.ts"
import { ModelRunner } from "./Model.ts"
import { Components, Runner } from "./Runtime.ts"
import * as Service from "./Service.ts"

const registered = [propRender]

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const show = (event: AgentEvent) =>
  Console.log(`${event.at.slice(11, 19)}  ${event.type.padEnd(30)} ${event.run.padEnd(24)} ${JSON.stringify(event.data).slice(0, 220)}`)

const terminal = (event: AgentEvent) => event.type.endsWith("/job.succeeded") || event.type.endsWith("/job.failed")

/** Run one job and stream its events until the runtime reports it finished. */
const runAndFollow = Effect.fnUntraced(function*(component: string, job: string, input: unknown, model: string | undefined) {
  const bus = yield* EventBus
  const runner = yield* Runner
  const finished = new Set<string>()
  let target: string | undefined
  const done = yield* Deferred.make<void>()
  yield* bus.subscribe.pipe(
    Stream.runForEach((event) => Effect.gen(function*() {
      yield* show(event)
      if (!terminal(event)) return
      finished.add(event.run)
      if (event.run === target) yield* Deferred.succeed(done, undefined)
    })),
    Effect.forkScoped
  )
  const result = yield* runner.run(component, job, input, model === undefined ? {} : { model })
  target = result.run
  if (!finished.has(result.run)) yield* Deferred.await(done).pipe(Effect.timeout("10 seconds"), Effect.ignore)
  return result
}, Effect.scoped)

const modelFlag = Flag.String("model").pipe(Flag.withDescription("omp model id overriding the component default"), Flag.optional)
const inputFlag = Flag.String("input").pipe(Flag.withDescription("job input as JSON"), Flag.withDefault("{}"))

const list = Command.make("list", {}, () =>
  Effect.forEach(registered, (component) =>
    Effect.gen(function*() {
      yield* Console.log(`${component.id}: ${component.purpose}`)
      yield* Console.log(`  agent   ${component.agent.model} (candidates: ${component.agent.candidates.join(", ")})`)
      for (const job of component.jobs) {
        const triggers = job.triggers.map((t) => t._tag === "Cron" ? `cron "${t.cron}"` : t._tag === "OnEvent" ? `on ${t.type}` : "manual")
        yield* Console.log(`  job     ${job.id} [${triggers.join(", ")}]: ${job.description}`)
      }
      yield* Console.log(`  events  ${Object.keys(component.events).map((name) => `${component.id}/${name}`).join(", ")}`)
    })))

const run = Command.make("run", {
  component: Argument.String("component"),
  job: Argument.String("job"),
  input: inputFlag,
  model: modelFlag
}, Effect.fnUntraced(function*({ component, job, input, model }) {
  const result = yield* runAndFollow(component, job, yield* parseJson(input), Option.getOrUndefined(model))
  if (!result.ok) return yield* Effect.fail(new Error(`run ${result.run} failed`))
}))

const bench = Command.make("bench", {
  component: Argument.String("component"),
  job: Argument.String("job"),
  input: inputFlag,
  models: Flag.String("models").pipe(Flag.withDescription("comma-separated omp model ids; default: the component's candidates"), Flag.optional)
}, Effect.fnUntraced(function*({ component, job, input, models }) {
  const spec = registered.find((candidate) => candidate.id === component)
  const arms = Option.match(models, { onNone: () => spec?.agent.candidates ?? [], onSome: (list) => list.split(",") })
  const decoded = yield* parseJson(input)
  const results = yield* Effect.forEach(arms, (model) => runAndFollow(component, job, decoded, model).pipe(Effect.map((result) => ({ model, ...result }))))
  yield* Console.log("\nbake-off (pick with: atomic-agents rate <run-a> <run-b> a|b|tie)")
  for (const result of results) yield* Console.log(`  ${result.ok ? "ok  " : "FAIL"} ${result.model.padEnd(32)} ${result.run}`)
}))

/** Pairwise A-vs-B pick between two runs of the same job; `wins` turns the picks into a win rate per model. */
const rate = Command.make("rate", {
  a: Argument.String("run-a"),
  b: Argument.String("run-b"),
  winner: Argument.Literals("winner", ["a", "b", "tie"]),
  note: Flag.String("note").pipe(Flag.withDefault(""))
}, Effect.fnUntraced(function*({ a, b, winner, note }) {
  const bus = yield* EventBus
  const history = yield* bus.history
  const [left, right] = [a, b].map((run) => history.find((event) => event.run === run && event.type.endsWith("/job.started")))
  if (left === undefined || right === undefined) return yield* Effect.fail(new Error(`no run ${left === undefined ? a : b} in the journal`))
  if (left.component !== right.component || left.job !== right.job) return yield* Effect.fail(new Error("both runs must come from the same job"))
  const model = (event: AgentEvent) =>
    Option.getOrElse(Option.map(Schema.decodeUnknownOption(Schema.Struct({ model: Schema.String }))(event.data), (data) => data.model), () => "")
  yield* bus.publish(yield* makeEvent({
    type: `${left.component}/pair.picked`,
    component: left.component,
    job: left.job,
    run: `pick-${crypto.randomUUID().slice(0, 8)}`,
    data: { a: { run: a, model: model(left) }, b: { run: b, model: model(right) }, winner, note }
  }))
  yield* Console.log(`picked ${winner === "tie" ? "tie" : `${winner}: ${model(winner === "a" ? left : right)}`}`)
}))

const Pick = Schema.Struct({
  a: Schema.Struct({ model: Schema.String }),
  b: Schema.Struct({ model: Schema.String }),
  winner: Schema.Literals(["a", "b", "tie"])
})

const wins = Command.make("wins", {
  component: Flag.String("component").pipe(Flag.withDefault(""))
}, Effect.fnUntraced(function*({ component }) {
  const tally = new Map<string, { won: number; lost: number; tied: number }>()
  for (const event of (yield* (yield* EventBus).history)) {
    if (!event.type.endsWith("/pair.picked") || (component !== "" && event.component !== component)) continue
    const pick = Schema.decodeUnknownOption(Pick)(event.data)
    if (Option.isNone(pick) || pick.value.a.model === pick.value.b.model) continue
    for (const side of ["a", "b"] as const) {
      const row = tally.get(`${event.component}  ${pick.value[side].model}`) ?? { won: 0, lost: 0, tied: 0 }
      if (pick.value.winner === "tie") row.tied++
      else if (pick.value.winner === side) row.won++
      else row.lost++
      tally.set(`${event.component}  ${pick.value[side].model}`, row)
    }
  }
  const rows = [...tally].map(([key, row]) => ({ key, ...row, rate: (row.won + row.tied / 2) / (row.won + row.lost + row.tied) }))
  if (rows.length === 0) return yield* Console.log("no pairwise picks yet")
  for (const row of rows.sort((x, y) => y.rate - x.rate)) {
    yield* Console.log(`${row.key.padEnd(48)} ${(row.rate * 100).toFixed(0).padStart(3)}%  ${row.won}W ${row.lost}L ${row.tied}T`)
  }
}))

const emit = Command.make("emit", {
  type: Argument.String("type"),
  data: Flag.String("data").pipe(Flag.withDefault("{}"))
}, Effect.fnUntraced(function*({ type, data }) {
  const [component = "", name = ""] = type.split("/")
  const schema = registered.find((candidate) => candidate.id === component)?.events[name]
  if (schema === undefined) return yield* Effect.fail(new Error(`${type} is not a declared event`))
  const encoded = yield* Schema.encodeUnknownEffect(schema)(yield* parseJson(data))
  const bus = yield* EventBus
  yield* bus.publish(yield* makeEvent({ type, component, job: "external", run: `external-${crypto.randomUUID().slice(0, 8)}`, data: encoded }))
}))

const events = Command.make("events", {
  type: Flag.String("type").pipe(Flag.withDescription("type prefix filter"), Flag.withDefault("")),
  limit: Flag.Int("limit").pipe(Flag.withDefault(30)),
  follow: Flag.Boolean("follow").pipe(Flag.withDefault(false))
}, Effect.fnUntraced(function*({ type, limit, follow }) {
  const bus = yield* EventBus
  const history = (yield* bus.history).filter((event) => event.type.startsWith(type))
  yield* Effect.forEach(history.slice(-limit), show)
  if (follow) yield* bus.subscribe.pipe(Stream.filter((event) => event.type.startsWith(type)), Stream.runForEach(show))
}))

const serve = Command.make("serve", {}, () =>
  Effect.gen(function*() {
    const home = yield* Home
    yield* Console.log(`atomic-agents serving ${registered.length} component(s); journal ${home.journal}`)
    return yield* (yield* Runner).serve
  }))

const service = Command.make("service").pipe(Command.withSubcommands([
  Command.make("install", {}, () =>
    Service.install.pipe(Effect.flatMap(({ plist, log }) => Console.log(`installed ${Service.LABEL}\n  plist ${plist}\n  log   ${log}`)))),
  Command.make("uninstall", {}, () =>
    Service.uninstall.pipe(Effect.flatMap(({ plist }) => Console.log(`uninstalled ${Service.LABEL} (removed ${plist})`)))),
  Command.make("status", {}, () =>
    Effect.gen(function*() {
      const state = yield* Service.status
      yield* Console.log(`${Service.LABEL}  ${state.state}${state.pid ? `  pid ${state.pid}` : ""}${state.lastExit ? `  last exit ${state.lastExit}` : ""}\n  plist ${state.plist}\n  log   ${state.log}`)
      if (state.state !== "running") return yield* Effect.fail(new Error("service is not running"))
    }))
]))

const App = Runner.layer.pipe(
  Layer.provideMerge(EventBus.layer),
  Layer.provideMerge(Home.layer),
  Layer.provideMerge(ModelRunner.omp),
  Layer.provideMerge(Layer.succeed(Components, registered)),
  Layer.provideMerge(BunServices.layer)
)

Command.make("atomic-agents").pipe(
  Command.withSubcommands([list, run, bench, rate, wins, emit, events, serve, service]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(App),
  BunRuntime.runMain
)
