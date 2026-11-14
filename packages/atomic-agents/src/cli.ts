#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { propRender } from "./components/prop-render/component.ts"
import { type AgentEvent, EventBus, Home, makeEvent } from "./Event.ts"
import { ModelRunner } from "./Model.ts"
import { Components, Runner } from "./Runtime.ts"

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
  yield* Console.log("\nbake-off (rate with: atomic-agents rate <run> <1-5>)")
  for (const result of results) yield* Console.log(`  ${result.ok ? "ok  " : "FAIL"} ${result.model.padEnd(32)} ${result.run}`)
}))

const rate = Command.make("rate", {
  run: Argument.String("run"),
  score: Argument.Int("score").pipe(Argument.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })))),
  note: Flag.String("note").pipe(Flag.withDefault(""))
}, Effect.fnUntraced(function*({ run, score, note }) {
  const bus = yield* EventBus
  const started = (yield* bus.history).find((event) => event.run === run && event.type.endsWith("/job.started"))
  if (started === undefined) return yield* Effect.fail(new Error(`no run ${run} in the journal`))
  const model = Schema.decodeUnknownOption(Schema.Struct({ model: Schema.String }))(started.data)
  yield* bus.publish(yield* makeEvent({
    type: `${started.component}/run.rated`,
    component: started.component,
    job: started.job,
    run,
    data: { score, note, model: Option.getOrElse(Option.map(model, (data) => data.model), () => "") }
  }))
  yield* Console.log(`rated ${run} ${score}/5`)
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

const App = Runner.layer.pipe(
  Layer.provideMerge(EventBus.layer),
  Layer.provideMerge(Home.layer),
  Layer.provideMerge(ModelRunner.omp),
  Layer.provideMerge(Layer.succeed(Components, registered)),
  Layer.provideMerge(BunServices.layer)
)

Command.make("atomic-agents").pipe(
  Command.withSubcommands([list, run, bench, rate, emit, events, serve]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(App),
  BunRuntime.runMain
)
