#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Clock, Console, Effect, FiberSet, FileSystem, Layer, Option, Path, Schema, Stream, SubscriptionRef } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Adapters } from "./Adapter.ts"
import { packs } from "./adapters/index.ts"
import { ask } from "./Ask.ts"
import { Background } from "./Background.ts"
import { Chefs, parseChef } from "./Chef.ts"
import { type EventSchemas, Trigger } from "./Component.ts"
import { type AgentEvent, EventBus, Home, lifecycle, makeEvent } from "./Event.ts"
import { shortId } from "./Id.ts"
import { ModelRunner } from "./Model.ts"
import { Runner } from "./Runtime.ts"
import { RUNTIME, runtime } from "./RuntimeEvents.ts"
import * as Service from "./Service.ts"
import { effective, Settings } from "./Settings.ts"

const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

const show = (event: AgentEvent) =>
  Console.log(`${event.at.slice(11, 19)}  ${event.type.padEnd(30)} ${event.run.padEnd(24)} ${JSON.stringify(event.data).slice(0, 220)}`)

/** Run one job and stream its events until the runtime reports it finished. */
const runAndFollow = Effect.fnUntraced(function*(component: string, job: string, input: unknown, model: string | undefined) {
  const bus = yield* EventBus
  const runner = yield* Runner
  // Runs whose job.succeeded / job.failed has arrived; the event can land before or after `run` returns.
  const finished = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set())
  yield* bus.subscribe.pipe(
    Stream.runForEach((event) =>
      show(event).pipe(Effect.andThen(Option.match(lifecycle(event), {
        onNone: () => Effect.void,
        onSome: ({ _tag }) => _tag === "job.started" ? Effect.void : SubscriptionRef.update(finished, (runs) => new Set([...runs, event.run]))
      })))),
    Effect.forkScoped
  )
  const result = yield* runner.run(component, job, input, model === undefined ? {} : { model })
  yield* SubscriptionRef.changes(finished).pipe(
    Stream.filter((runs) => runs.has(result.run)),
    Stream.runHead,
    Effect.timeout("10 seconds"),
    Effect.ignore
  )
  return result
}, Effect.scoped)

const modelFlag = Flag.String("model").pipe(Flag.withDescription("omp model id overriding the component default"), Flag.optional)
const inputFlag = Flag.String("input").pipe(Flag.withDescription("job input as JSON"), Flag.withDefault("{}"))

const list = Command.make("list", {}, () =>
  Effect.gen(function*() {
    const settings = yield* Settings
    const current = yield* settings.current
    yield* Console.log(`config ${settings.file}`)
    for (const component of yield* (yield* Chefs).current) {
      const resolved = effective(component, current)
      yield* Console.log(`${component.id}${resolved.enabled ? "" : " (disabled)"}: ${component.purpose}`)
      yield* Console.log(`  file    ${component.file ?? "(code, passed in by the host)"} [${component.kind}]`)
      yield* Console.log(`  agent   ${resolved.agent.model}${resolved.agent.thinking ? ` thinking ${resolved.agent.thinking}` : ""} (candidates: ${resolved.agent.candidates.join(", ")})`)
      for (const job of component.jobs) {
        const triggers = job.triggers.map(Trigger.$match({
          Manual: () => "manual",
          Cron: ({ cron }) => `cron "${resolved.cron(job.id, cron)}"`,
          OnEvent: ({ type }) => `on ${type}`
        }))
        yield* Console.log(`  job     ${job.id} [${triggers.join(", ")}]: ${job.description}`)
      }
      yield* Console.log(`  events  ${Object.keys(component.events).map((name) => `${component.id}/${name}`).join(", ")}`)
    }
  }))

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
  const spec = (yield* (yield* Chefs).current).find((candidate) => candidate.id === component)
  const candidates = spec === undefined ? [] : effective(spec, yield* (yield* Settings).current).agent.candidates
  const arms = Option.match(models, { onNone: () => candidates, onSome: (list) => list.split(",") })
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
  const [left, right] = [a, b].map((run) =>
    history.flatMap((event) => {
      const started = lifecycle(event)
      return event.run === run && Option.isSome(started) && started.value._tag === "job.started" ? [{ event, model: started.value.model }] : []
    })[0])
  if (left === undefined || right === undefined) return yield* Effect.fail(new Error(`no run ${left === undefined ? a : b} in the journal`))
  if (left.event.component !== right.event.component || left.event.job !== right.event.job) return yield* Effect.fail(new Error("both runs must come from the same job"))
  yield* bus.publish(yield* makeEvent({
    type: `${left.event.component}/pair.picked`,
    component: left.event.component,
    job: left.event.job,
    run: `pick-${yield* shortId}`,
    data: { a: { run: a, model: left.model }, b: { run: b, model: right.model }, winner, note }
  }))
  yield* Console.log(`picked ${winner === "tie" ? "tie" : `${winner}: ${(winner === "a" ? left : right).model}`}`)
}))

const Pick = Schema.Struct({
  a: Schema.Struct({ model: Schema.String }),
  b: Schema.Struct({ model: Schema.String }),
  winner: Schema.Literals(["a", "b", "tie"])
})

const wins = Command.make("wins", {
  component: Flag.String("component").pipe(Flag.withDefault(""))
}, Effect.fnUntraced(function*({ component }) {
  const tally = new Map<string, { component: string; model: string; won: number; lost: number; tied: number }>()
  for (const event of (yield* (yield* EventBus).history)) {
    if (!event.type.endsWith("/pair.picked") || (component !== "" && event.component !== component)) continue
    const pick = Schema.decodeUnknownOption(Pick)(event.data)
    if (Option.isNone(pick) || pick.value.a.model === pick.value.b.model) continue
    for (const side of ["a", "b"] as const) {
      const key = `${event.component}  ${pick.value[side].model}`
      const row = tally.get(key) ?? { component: event.component, model: pick.value[side].model, won: 0, lost: 0, tied: 0 }
      if (pick.value.winner === "tie") row.tied++
      else if (pick.value.winner === side) row.won++
      else row.lost++
      tally.set(key, row)
    }
  }
  const rows = [...tally.values()].map((row) => ({ ...row, rate: (row.won + row.tied / 2) / (row.won + row.lost + row.tied) }))
  if (rows.length === 0) return yield* Console.log("no pairwise picks yet")
  rows.sort((x, y) => y.rate - x.rate)
  for (const row of rows) {
    yield* Console.log(`${`${row.component}  ${row.model}`.padEnd(48)} ${(row.rate * 100).toFixed(0).padStart(3)}%  ${row.won}W ${row.lost}L ${row.tied}T`)
  }
  // The winner goes into config.json, never into code.
  const current = yield* (yield* Settings).current
  for (const spec of yield* (yield* Chefs).current) {
    const best = rows.find((row) => row.component === spec.id)
    if (best === undefined) continue
    const inForce = effective(spec, current).agent.model
    yield* Console.log(inForce === best.model
      ? `\n${spec.id} already uses its winner ${best.model}`
      : `\n${spec.id} uses ${inForce}; promote the winner with: atomic-agents use ${spec.id} ${best.model}`)
  }
}))

/** Set a component's model in config.json (the bake-off winner); a running service applies it to the next run. */
const use = Command.make("use", {
  component: Argument.String("component"),
  model: Argument.String("model"),
  by: Flag.String("by").pipe(Flag.withDescription("who is changing it (recorded on config.changed)"), Flag.withDefault(Bun.env["USER"] ?? "cli"))
}, Effect.fnUntraced(function*({ component, model, by }) {
  const settings = yield* Settings
  const changes = yield* settings.set({ components: { [component]: { model } } }, by, "use")
  if (changes.length === 0) return yield* Console.log(`${component} already uses ${model}`)
  for (const change of changes) yield* Console.log(`${change.path.join(".")}: ${JSON.stringify(change.old)} -> ${JSON.stringify(change.new)}`)
  yield* Console.log(`written to ${settings.file}; a running service applies it from the next run`)
}))

/** Set how a consumer uses a component's answers (widget: Relay Host under assistants' replies); it reads config.json on every request. */
const mode = Command.make("mode", {
  component: Argument.String("component"),
  mode: Argument.Literals("mode", ["shadow", "live", "off"]),
  by: Flag.String("by").pipe(Flag.withDescription("who is changing it (recorded on config.changed)"), Flag.withDefault(Bun.env["USER"] ?? "cli"))
}, Effect.fnUntraced(function*({ component, mode, by }) {
  const settings = yield* Settings
  const changes = yield* settings.set({ components: { [component]: { mode } } }, by, "set")
  if (changes.length === 0) return yield* Console.log(`${component} is already ${mode}`)
  for (const change of changes) yield* Console.log(`${change.path.join(".")}: ${JSON.stringify(change.old)} -> ${JSON.stringify(change.new)}`)
  yield* Console.log(`written to ${settings.file}; Relay Host applies it from the next reply`)
}))

const emit = Command.make("emit", {
  type: Argument.String("type"),
  data: Flag.String("data").pipe(Flag.withDefault("{}"))
}, Effect.fnUntraced(function*({ type, data }) {
  const [component = "", name = ""] = type.split("/")
  const declared: EventSchemas | undefined = component === RUNTIME
    ? runtime.events
    : (yield* (yield* Chefs).current).find((candidate) => candidate.id === component)?.events
  const schema = declared?.[name]
  if (schema === undefined) return yield* Effect.fail(new Error(`${type} is not a declared event`))
  const encoded = yield* Schema.encodeUnknownEffect(schema)(yield* parseJson(data))
  const bus = yield* EventBus
  yield* bus.publish(yield* makeEvent({ type, component, job: "external", run: `external-${yield* shortId}`, data: encoded }))
}))

const TIMEOUT = /^(\d+(?:\.\d+)?)(ms|s)$/
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/** Request/response: emit the component's request and print its reply, or `none` (exit 1) when none comes in time. The service answers. */
const askCommand = Command.make("ask", {
  component: Argument.String("component"),
  data: Argument.String("data").pipe(Argument.withDescription("the request as JSON, without requestId")),
  timeout: Flag.String("timeout").pipe(Flag.withDescription("how long to wait for the reply: 2s, 1500ms"), Flag.withDefault("5s"))
}, Effect.fnUntraced(function*({ component, data, timeout }) {
  const chefs = yield* (yield* Chefs).current
  const spec = chefs.find((candidate) => candidate.id === component)
  if (spec?.asks === undefined) return yield* Effect.fail(new Error(`${component} answers no requests (have: ${chefs.filter((c) => c.asks).map((c) => c.id).join(", ")})`))
  const [, amount = "", unit] = TIMEOUT.exec(timeout) ?? []
  if (unit === undefined) return yield* Effect.fail(new Error(`--timeout ${timeout}: write it as 2s or 1500ms`))
  const millis = Number(amount) * (unit === "s" ? 1000 : 1)
  const started = yield* Clock.currentTimeMillis
  const reply = yield* ask(spec, spec.asks, yield* decodeRequest(data), millis).pipe(
    Effect.tapError((error) => error._tag === "AskTimeout" ? Console.log("none") : Effect.void)
  )
  const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000
  yield* Console.log(spec.asks.show(reply.data))
  yield* Console.error(`answered in ${seconds.toFixed(2)}s: ${JSON.stringify(reply.data).slice(0, 300)}`)
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

/** A new chef file in `<home>/chefs`: a working request/reply recipe to edit, never an existing id. */
const scaffold = (id: string) => ({
  id,
  purpose: "One sentence: what this chef turns its request into.",
  agent: {
    model: "anthropic/claude-haiku-5-5",
    candidates: ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5"],
    thinking: "off",
    system: ["You are a narrow specialist. Say what you do, what good looks like, and what you never do."]
  },
  events: {
    [`${id}.requested`]: { requestId: "nonEmptyString", text: "string" },
    [`${id}.ready`]: { requestId: "string", answer: "string" }
  },
  job: {
    id: "answer",
    description: `Answer a ${id}.requested with ${id}.ready.`,
    input: `${id}.requested`,
    triggers: [{ onEvent: `${id}.requested` }, "manual"],
    prompt: "{{text}}",
    answer: { answer: "string" },
    output: `${id}.ready`
  },
  asks: { request: `${id}.requested`, reply: `${id}.ready`, show: "answer" }
})

const chef = Command.make("chef").pipe(Command.withSubcommands([
  Command.make("new", { id: Argument.String("id") }, Effect.fnUntraced(function*({ id }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join((yield* Home).root, "chefs", `${id}.json`)
    const taken = (yield* (yield* Chefs).current).find((candidate) => candidate.id === id)
    if (taken !== undefined) return yield* Effect.fail(new Error(`a chef ${id} exists (${taken.file ?? "code"}); edit or copy that file instead`))
    if (yield* fs.exists(file)) return yield* Effect.fail(new Error(`${file} exists`))
    const text = `${JSON.stringify(scaffold(id), null, 2)}\n`
    yield* parseChef(file, text)
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, text)
    yield* Console.log(`wrote ${file}\nedit purpose, system, events and prompt; check it with: atomic-agents chef validate ${file}\na running service loads it within a second (chef.loaded)`)
  })),
  Command.make("validate", {
    files: Argument.String("file").pipe(Argument.withDescription("chef files; default: every file in the chef dirs"), Argument.variadic())
  }, Effect.fnUntraced(function*({ files }) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const chefs = yield* Chefs
    const all = files.length > 0
      ? files.map((file) => path.resolve(file))
      : (yield* Effect.forEach(chefs.dirs, (dir) =>
        fs.readDirectory(dir).pipe(
          Effect.map((names) => names.filter((name) => /\.(json|ya?ml)$/.test(name)).sort().map((name) => path.join(dir, name))),
          Effect.orElseSucceed((): ReadonlyArray<string> => [])
        ))).flat()
    let failed = 0
    for (const file of all) {
      const result = yield* Effect.result(fs.readFileString(file).pipe(Effect.flatMap((text) => parseChef(file, text))))
      if (result._tag === "Success") yield* Console.log(`ok    ${result.success.chef.id.padEnd(20)} ${result.success.kind.padEnd(6)} ${file}`)
      else {
        failed++
        yield* Console.log(`FAIL  ${result.failure.message}`)
      }
    }
    if (failed > 0) return yield* Effect.fail(new Error(`${failed} of ${all.length} chef file(s) failed`))
  }))
]))

/** The service: config and chef file watch, and triggers, as background layers; the first fatal error (see `Background`) ends it. */
const Serve = Layer.mergeAll(Settings.layerWatch, Chefs.layerWatch, Runner.layerTriggers).pipe(Layer.provideMerge(Background.layer))

const serve = Command.make("serve", {}, () =>
  Effect.gen(function*() {
    const home = yield* Home
    const chefs = yield* Chefs
    yield* Console.log(`atomic-agents serving ${(yield* chefs.current).length} chef(s) from ${chefs.dirs.join(", ")} (live); journal ${home.journal}; config ${(yield* Settings).file} (live)`)
    return yield* FiberSet.join(yield* Background)
  }).pipe(Effect.provide(Serve)))

const service = Command.make("service").pipe(Command.withSubcommands([
  Command.make("install", {}, () =>
    Service.install.pipe(Effect.flatMap(({ plist, log, app }) => Console.log(`installed ${Service.LABEL}\n  app   ${app}\n  plist ${plist}\n  log   ${log}`)))),
  Command.make("uninstall", {}, () =>
    Service.uninstall.pipe(Effect.flatMap(({ plist }) => Console.log(`uninstalled ${Service.LABEL} (removed ${plist})`)))),
  Command.make("status", {}, () =>
    Effect.gen(function*() {
      const state = yield* Service.status
      yield* Console.log(`${Service.LABEL}  ${state.state}${state.pid ? `  pid ${state.pid}` : ""}${state.lastExit ? `  last exit ${state.lastExit}` : ""}\n  runs  ${state.command ?? "-"}\n  plist ${state.plist}\n  log   ${state.log}`)
      if (state.state !== "running") return yield* Effect.fail(new Error("service is not running"))
    }))
]))

const App = Runner.layer.pipe(
  Layer.provideMerge(ModelRunner.omp),
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(Chefs.layer),
  Layer.provideMerge(Adapters.make(packs)),
  Layer.provideMerge(EventBus.layer),
  Layer.provideMerge(Home.layer),
  Layer.provideMerge(BunServices.layer)
)

Command.make("atomic-agents").pipe(
  Command.withSubcommands([list, run, bench, rate, wins, use, mode, emit, askCommand, events, chef, serve, service]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(App),
  BunRuntime.runMain
)
