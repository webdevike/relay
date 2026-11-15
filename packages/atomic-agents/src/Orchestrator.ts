import { Clock, Config, Context, Cron, DateTime, Effect, FiberSet, FileSystem, Layer, Option, Path, Ref, Result, Schedule, Schema, Semaphore, Stream, SubscriptionRef, SynchronizedRef } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { ChildProcessSpawner } from "effect/process"
import { Adapters } from "./Adapter.ts"
import { ask } from "./Ask.ts"
import { Background } from "./Background.ts"
import { type Chef, Chefs, expandPath } from "./Chef.ts"
import { eventType } from "./Component.ts"
import { EventBus, Home, type JournalError, makeEvent } from "./Event.ts"
import { exec } from "./exec.ts"
import { shortId, uuid } from "./Id.ts"
import { generateWithTools, ModelRunner } from "./Model.ts"
import { placeholders, render } from "./Recipe.ts"
import { publishRuntime, Thinking } from "./RuntimeEvents.ts"

/**
 * Orchestrators: one per goal. An orchestrator never cooks: each tick it reads its handoff, its log, the
 * journal and its measure, makes ONE planning model call, dispatches steps (chef requests, or a full omp
 * agent-session as the escape hatch, `kind: "session"`) and reports. Files live in `<home>/orchestrators/<id>.json`
 * (or `.yaml`), Effect Schema, re-read every second. A tick never overlaps another of the same orchestrator.
 */
const Lines = Schema.Union([Schema.String, Schema.Array(Schema.String)])
const join = (lines: string | ReadonlyArray<string>) => typeof lines === "string" ? lines : lines.join("\n")
const Then = Schema.Literals(["pause", "ask"])

const Stop = Schema.Union([
  /** No round beat the best before it by more than `epsilon` for `rounds` rounds. */
  Schema.Struct({ when: Schema.Literal("flat"), rounds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), epsilon: Schema.optionalKey(Schema.Number), then: Then }),
  /** The measure reached its target. */
  Schema.Struct({ when: Schema.Literal("met"), then: Then }),
  /** The plan says its next step needs one of these (purchase, push, external): Isaac decides. */
  Schema.Struct({ when: Schema.Literal("needs"), kinds: Schema.Array(Schema.NonEmptyString), then: Then })
])
type Stop = typeof Stop.Type

const ChefStep = Schema.Struct({
  kind: Schema.Literal("chef"),
  description: Schema.NonEmptyString,
  chef: Schema.NonEmptyString,
  /** The chef's request event; the planner's input is its data. */
  request: Schema.NonEmptyString,
  /** Seconds to wait for the chef's reply (its `asks` pair); without it the request is fire and forget. */
  wait: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0)))
})

const SessionStep = Schema.Struct({
  kind: Schema.Literal("session"),
  description: Schema.NonEmptyString,
  /** Whose assistant thread owns the session (default `reportTo`). */
  owner: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.NonEmptyString,
  thinking: Thinking,
  title: Schema.NonEmptyString,
  cwd: Schema.optionalKey(Schema.NonEmptyString),
  /** agent-session `--max-time` (3h, 90m). */
  maxTime: Schema.optionalKey(Schema.NonEmptyString),
  /** The session's task; `{{field}}` comes from the planner's input. */
  task: Lines,
  /** The file whose appearance means the step finished (else the session ending does). */
  done: Schema.NonEmptyString
})
const Step = Schema.Union([ChefStep, SessionStep])
type Step = typeof Step.Type

const ContextFile = Schema.Union([
  Schema.Struct({ file: Schema.NonEmptyString, maxChars: Schema.optionalKey(Schema.Int), label: Schema.optionalKey(Schema.String) }),
  /** The last match of a file-name pattern (`dir/CRITIC-R*.md`), numbers sorted as numbers. */
  Schema.Struct({ latest: Schema.NonEmptyString, maxChars: Schema.optionalKey(Schema.Int), label: Schema.optionalKey(Schema.String) })
])

export const OrchestratorFile = Schema.Struct({
  id: Schema.String,
  kind: Schema.optionalKey(Schema.Literal("orchestrator")),
  /** One sentence. */
  goal: Schema.NonEmptyString,
  /**
   * How progress is read, oldest first: a `command` printing `<label> <number>` lines, or every `event` of a type
   * and its numeric `field`. The last value is the current one.
   */
  measure: Schema.Struct({
    label: Schema.NonEmptyString,
    command: Schema.optionalKey(Schema.Array(Schema.String)),
    cwd: Schema.optionalKey(Schema.NonEmptyString),
    event: Schema.optionalKey(Schema.NonEmptyString),
    field: Schema.optionalKey(Schema.NonEmptyString),
    target: Schema.Struct({ op: Schema.Literals([">=", ">", "<=", "<"]), value: Schema.Number })
  }),
  /** Chef ids it may call: each must be loaded. */
  chefs: Schema.Array(Schema.NonEmptyString),
  /** Chefs it will call once they exist; told to the planner, never called. */
  planned: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  /** Model adapter for planning turns, default `omp`. */
  adapter: Schema.optionalKey(Schema.NonEmptyString),
  model: Schema.NonEmptyString,
  thinking: Schema.optionalKey(Thinking),
  /** Extra planning instructions. */
  system: Schema.optionalKey(Lines),
  cadence: Schema.Union([Schema.Literal("loop"), Schema.Struct({ cron: Schema.NonEmptyString })]),
  /** Seconds between ticks of a loop (default 60). */
  loopSeconds: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
  /** Default true. A disabled orchestrator never ticks on its own; dry runs still work. */
  enabled: Schema.optionalKey(Schema.Boolean),
  budget: Schema.Struct({
    /** Session hours started today (UTC), running ones counted to now. */
    maxHoursPerDay: Schema.Number,
    /** Dispatches until the next resume. */
    maxRuns: Schema.Int,
    /** Planning USD until the next resume. */
    maxUsd: Schema.Number
  }),
  stop: Schema.Array(Stop),
  /** The assistant told about pauses (default nova). */
  reportTo: Schema.optionalKey(Schema.NonEmptyString),
  /** Its handoff file (default `<home>/state/orchestrators/<id>/HANDOFF.md`); each tick appends to it and reads it back. */
  handoff: Schema.optionalKey(Schema.NonEmptyString),
  /** Files the planner reads each tick (besides handoff, log and journal). */
  context: Schema.optionalKey(Schema.Array(ContextFile)),
  steps: Schema.Record(Schema.String, Step)
})
export type OrchestratorFile = typeof OrchestratorFile.Type

/** Its own events: `<id>/orchestrator.progress` and friends. */
export const events = {
  "orchestrator.progress": Schema.Struct({
    reportTo: Schema.String,
    measure: Schema.Struct({ label: Schema.String, value: Schema.NullOr(Schema.Number), target: Schema.String, met: Schema.Boolean }),
    decision: Schema.String,
    why: Schema.String,
    next: Schema.String,
    dispatched: Schema.Array(Schema.String)
  }),
  "orchestrator.paused": Schema.Struct({ reportTo: Schema.String, why: Schema.String, rule: Schema.String }),
  "orchestrator.resumed": Schema.Struct({ by: Schema.String })
}

const Plan = Schema.Struct({
  decision: Schema.Literals(["dispatch", "wait", "pause", "done"]),
  why: Schema.String,
  dispatch: Schema.Array(Schema.Struct({ step: Schema.String, input: Schema.Record(Schema.String, Schema.Json) })),
  next: Schema.String,
  needs: Schema.Array(Schema.String)
})
export type Plan = typeof Plan.Type

const Pending = Schema.Struct({ step: Schema.String, session: Schema.String, done: Schema.String, startedAt: Schema.Number })
const State = Schema.Struct({
  paused: Schema.NullOr(Schema.Struct({ why: Schema.String, rule: Schema.String, at: Schema.String })),
  pending: Schema.Array(Pending),
  runs: Schema.Int,
  usd: Schema.Number,
  /** UTC day → session hours that finished that day. */
  hours: Schema.Record(Schema.String, Schema.Number),
  ticks: Schema.Int
})
export type State = typeof State.Type
const EMPTY: State = { paused: null, pending: [], runs: 0, usd: 0, hours: {}, ticks: 0 }
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(State))

export class OrchestratorError extends Schema.TaggedError<OrchestratorError>()("OrchestratorError", { message: Schema.String }) {}

/** A loaded orchestrator: its file, decoded and checked, with paths resolved. */
export interface Orchestrator {
  readonly id: string
  readonly file: string
  readonly spec: OrchestratorFile
  readonly handoff: string
  readonly stateDir: string
  readonly measureCwd: string | undefined
  readonly context: ReadonlyArray<{ readonly path: string; readonly latest: boolean; readonly maxChars: number; readonly label: string }>
  /** Each step's planner inputs (its template fields). */
  readonly inputs: ReadonlyMap<string, ReadonlyArray<string>>
  readonly reportTo: string
}

/** A full omp agent-session (`.omp/tools/agent-session.ts`): the escape hatch when no chef fits. */
export class Sessions extends Context.Service<Sessions, {
  start(spec: { owner: string; model: string; thinking: string; title: string; cwd?: string; maxTime?: string; task: string }): Effect.Effect<string, OrchestratorError>
  /** `running`, `starting`, `done`, `failed`, `stopped`, ... or `unknown`. */
  state(id: string): Effect.Effect<string>
}>()("atomic-agents/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const eva = yield* Config.String("EVA_ROOT").pipe(Config.withDefault(path.join(yield* Config.String("HOME"), "Eva")))
      const tool = path.join(eva, ".omp", "tools", "agent-session.ts")
      const RunRecord = Schema.fromJsonString(Schema.Struct({ state: Schema.String }))
      return Sessions.of({
        start: (spec) =>
          exec(process.execPath, [
            tool, "start", "--owner", spec.owner, "--model", spec.model, "--thinking", spec.thinking, "--title", spec.title,
            ...(spec.cwd ? ["--cwd", spec.cwd] : []), ...(spec.maxTime ? ["--max-time", spec.maxTime] : []), spec.task
          ], { cwd: eva }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError((error) => new OrchestratorError({ message: `agent-session start: ${error.message}` })),
            Effect.flatMap((result) => {
              const id = /^started (\S+)/m.exec(result.stdout)?.[1]
              return result.exitCode === 0 && id !== undefined
                ? Effect.succeed(id)
                : Effect.fail(new OrchestratorError({ message: `agent-session start: ${(result.stderr || result.stdout).trim().slice(-300)}` }))
            })
          ),
        state: (id) =>
          fs.readFileString(path.join(eva, "work", "eva", "agent-sessions", `${id}.json`)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(RunRecord)),
            Effect.map((record) => record.state),
            Effect.orElseSucceed(() => "unknown")
          )
      })
    })
  )
}

/** Tells an assistant thread something (`.omp/tools/eva-thread.ts`); the assistant decides what reaches Isaac. */
export class Reporter extends Context.Service<Reporter, {
  say(agent: string, text: string): Effect.Effect<void>
}>()("atomic-agents/Reporter") {
  static readonly layer = Layer.effect(
    Reporter,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const path = yield* Path.Path
      const eva = yield* Config.String("EVA_ROOT").pipe(Config.withDefault(path.join(yield* Config.String("HOME"), "Eva")))
      return Reporter.of({
        say: (agent, text) =>
          exec(process.execPath, [path.join(eva, ".omp", "tools", "eva-thread.ts"), "--agent", agent, text], { cwd: eva }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.flatMap((result) => result.exitCode === 0 ? Effect.void : Effect.logWarning(`eva-thread: ${result.stderr.trim().slice(-300)}`)),
            Effect.catch((error) => Effect.logWarning(`eva-thread: ${error.message}`))
          )
      })
    })
  )
}

const ID = /^[a-z][a-z0-9-]*$/
const EXTENSIONS = /\.(json|ya?ml)$/
const decodeFile = Schema.decodeUnknownEffect(OrchestratorFile, { onExcessProperty: "error" })

/** Read, decode and check one orchestrator file against the chefs in force. */
export const parseOrchestrator = Effect.fn("Orchestrator.parse")(function*(file: string, text: string, chefs: ReadonlyArray<Chef>) {
  const path = yield* Path.Path
  const home = yield* Home
  const adapters = yield* Adapters
  const fail = (message: string) => Effect.fail(new OrchestratorError({ message: `${file}: ${message}` }))
  const raw = yield* Effect.try({
    try: (): unknown => file.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text),
    catch: (error) => new OrchestratorError({ message: `${file}: not valid ${file.endsWith(".json") ? "JSON" : "YAML"}: ${String(error)}` })
  })
  const spec = yield* decodeFile(raw).pipe(Effect.catchTag("SchemaError", (error) => fail(error.message)))
  const stem = path.basename(file).replace(EXTENSIONS, "")
  const errors: Array<string> = []
  if (!ID.test(spec.id)) errors.push(`id must be kebab-case (got ${JSON.stringify(spec.id)})`)
  else if (spec.id !== stem) errors.push(`id ${spec.id} must match the file name (${stem})`)
  const dir = path.dirname(file)

  const { measure } = spec
  if ((measure.command === undefined) === (measure.event === undefined)) errors.push("measure: either command or event (with field)")
  if (measure.event !== undefined && measure.field === undefined) errors.push("measure.event needs measure.field")
  if (measure.command !== undefined && measure.command.length === 0) errors.push("measure.command is empty")
  if (typeof spec.cadence === "object" && Result.isFailure(Cron.parse(spec.cadence.cron))) errors.push(`cadence: bad cron ${JSON.stringify(spec.cadence.cron)}`)
  if (!adapters.models.has(spec.adapter ?? "omp")) errors.push(`unknown model adapter "${spec.adapter}" (have: ${[...adapters.models.keys()].join(", ")})`)

  const loaded = new Map(chefs.map((chef) => [chef.id, chef] as const))
  for (const id of spec.chefs) {
    if (!loaded.has(id)) errors.push(`chefs: unknown chef ${id} (loaded: ${[...loaded.keys()].join(", ") || "none"})`)
  }
  const inputs = new Map<string, ReadonlyArray<string>>()
  for (const [name, step] of Object.entries(spec.steps)) {
    if (!ID.test(name)) errors.push(`steps.${name}: step names are kebab-case`)
    if (step.kind === "chef") {
      const chef = loaded.get(step.chef)
      if (!spec.chefs.includes(step.chef)) errors.push(`steps.${name}: chef ${step.chef} is not in chefs`)
      else if (chef !== undefined && chef.events[step.request] === undefined) errors.push(`steps.${name}: ${step.chef} declares no event ${step.request}`)
      if (step.wait !== undefined && chef !== undefined && chef.asks?.request !== step.request) errors.push(`steps.${name}: wait needs ${step.chef} to answer ${step.request} (its asks)`)
      inputs.set(name, [])
    } else {
      inputs.set(name, [...new Set([...placeholders(join(step.task)), ...placeholders(step.title), ...placeholders(step.done)])])
    }
  }
  if (Object.keys(spec.steps).length === 0) errors.push("steps: at least one")

  const resolve = Effect.fnUntraced(function*(raw: string, at: string) {
    const target = yield* expandPath(raw, dir)
    if (!target.ok) errors.push(`${at}: ${target.error}`)
    return target.ok ? target.path : raw
  })
  const handoff = spec.handoff === undefined
    ? path.join(home.root, "state", "orchestrators", spec.id, "HANDOFF.md")
    : yield* resolve(spec.handoff, "handoff")
  const measureCwd = measure.cwd === undefined ? undefined : yield* resolve(measure.cwd, "measure.cwd")
  const context = yield* Effect.forEach(spec.context ?? [], (entry, index) =>
    Effect.map(resolve("file" in entry ? entry.file : entry.latest, `context[${index}]`), (resolved) => ({
      path: resolved,
      latest: "latest" in entry,
      maxChars: entry.maxChars ?? 6000,
      label: entry.label ?? ("file" in entry ? entry.file : entry.latest)
    })))
  if (errors.length > 0) return yield* fail(errors.join("; "))
  return {
    id: spec.id,
    file,
    spec,
    handoff,
    stateDir: path.join(home.root, "state", "orchestrators", spec.id),
    measureCwd,
    context,
    inputs,
    reportTo: spec.reportTo ?? "nova"
  } satisfies Orchestrator
})

/** `label value` lines, oldest first. */
const parseSeries = (text: string) =>
  text.split("\n").flatMap((line) => {
    const match = /^\s*(.*?)\s+(-?\d+(?:\.\d+)?)\s*$/.exec(line)
    return match === null ? [] : [{ label: match[1]!, value: Number(match[2]) }]
  })

const meets = (value: number, target: OrchestratorFile["measure"]["target"]) =>
  target.op === ">=" ? value >= target.value : target.op === ">" ? value > target.value : target.op === "<=" ? value <= target.value : value < target.value

/**
 * Which stop rules hit: `met` when the latest value meets the target; `flat` when none of the last `rounds`
 * values beat the best before them by more than `epsilon` (lower is better for `<`/`<=` targets).
 */
export const stopsHit = (
  rules: ReadonlyArray<Stop>,
  series: ReadonlyArray<{ readonly label: string; readonly value: number }>,
  target: OrchestratorFile["measure"]["target"]
): ReadonlyArray<{ readonly rule: string; readonly then: "pause" | "ask"; readonly why: string }> => {
  const higher = target.op.startsWith(">")
  const current = series.at(-1)
  return rules.flatMap((rule) => {
    if (rule.when === "met") {
      return current !== undefined && meets(current.value, target)
        ? [{ rule: "met", then: rule.then, why: `goal met: ${current.label} ${current.value} ${target.op} ${target.value}` }]
        : []
    }
    if (rule.when === "flat") {
      if (series.length <= rule.rounds) return []
      const before = series.slice(0, -rule.rounds).map((point) => point.value)
      const recent = series.slice(-rule.rounds)
      const best = higher ? Math.max(...before) : Math.min(...before)
      const epsilon = rule.epsilon ?? 0
      const improved = recent.some((point) => higher ? point.value > best + epsilon : point.value < best - epsilon)
      return improved ? [] : [{
        rule: `flat ${rule.rounds}`,
        then: rule.then,
        why: `flat for ${rule.rounds} rounds: ${recent.map((point) => `${point.label} ${point.value}`).join(", ")} vs best before ${best}`
      }]
    }
    return []
  })
}

const naturalLast = (names: ReadonlyArray<string>) => [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)

/** What one tick saw and decided; a dry run fills it without writing, emitting or dispatching anything. */
export interface Tick {
  readonly id: string
  readonly status: "busy" | "paused" | "stopped" | "waiting" | "planned"
  readonly measure: { readonly series: ReadonlyArray<{ readonly label: string; readonly value: number }>; readonly target: string; readonly met: boolean }
  readonly stops: ReadonlyArray<{ readonly rule: string; readonly then: string; readonly why: string }>
  readonly pending: ReadonlyArray<{ readonly step: string; readonly session: string; readonly finished: boolean }>
  readonly plan: Plan | undefined
  readonly cost: number
  /** Each dispatch as it would run: the chef event and data, or the session's title and task. */
  readonly dispatches: ReadonlyArray<{ readonly step: string; readonly kind: string; readonly what: string; readonly error?: string }>
  readonly why: string
}

export class Orchestrators extends Context.Service<Orchestrators, {
  readonly dir: string
  readonly current: Effect.Effect<ReadonlyArray<Orchestrator>>
  readonly changes: Stream.Stream<ReadonlyArray<Orchestrator>>
  readonly reload: Effect.Effect<void, JournalError>
  /** One tick (`dry`: plan only, nothing written, emitted or dispatched). A tick already running answers `busy`. */
  tick(id: string, mode: "live" | "dry"): Effect.Effect<Tick, OrchestratorError | JournalError>
  readonly state: (id: string) => Effect.Effect<State, OrchestratorError>
  pause(id: string, why: string): Effect.Effect<void, OrchestratorError | JournalError>
  resume(id: string, by: string): Effect.Effect<void, OrchestratorError | JournalError>
}>()("atomic-agents/Orchestrators") {
  static readonly make = (options: { readonly dir?: (home: string) => string } = {}) =>
    Layer.effect(
      Orchestrators,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* Home
        const bus = yield* EventBus
        const chefs = yield* Chefs
        const adapters = yield* Adapters
        const sessions = yield* Sessions
        const reporter = yield* Reporter
        const services = yield* Effect.context<BunServices | Home | Adapters | EventBus>()
        // Planning goes through the named model adapter; omp's uses this process's runner.
        const runner = yield* ModelRunner
        const dir = options.dir?.(home.root) ?? path.join(home.root, "orchestrators")
        const scanLock = yield* Semaphore.make(1)
        const texts = yield* Ref.make<ReadonlyMap<string, { readonly text: string; readonly orchestrator: Orchestrator | undefined }>>(new Map())
        const ref = yield* SubscriptionRef.make<ReadonlyArray<Orchestrator>>([])

        const scan = (announce: boolean) =>
          Effect.gen(function*() {
            const say = <K extends "orchestrator.loaded" | "orchestrator.removed" | "config.rejected">(name: K, data: Parameters<typeof publishRuntime<K>>[2]) =>
              announce ? publishRuntime(bus, name, data, "orchestrators") : Effect.void
            const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
            const files = names.filter((name) => EXTENSIONS.test(name)).sort().map((name) => path.join(dir, name))
            const before = yield* Ref.get(texts)
            const after = new Map<string, { readonly text: string; readonly orchestrator: Orchestrator | undefined }>()
            const loadedChefs = yield* chefs.current
            for (const file of files) {
              const text = yield* fs.readFileString(file).pipe(Effect.option)
              const previous = before.get(file)
              if (Option.isNone(text) || previous?.text === text.value) {
                if (previous) after.set(file, previous)
                continue
              }
              const parsed = yield* Effect.result(parseOrchestrator(file, text.value, loadedChefs).pipe(Effect.provideContext(services)))
              if (parsed._tag === "Failure") {
                after.set(file, { text: text.value, orchestrator: previous?.orchestrator })
                yield* Effect.logWarning(`orchestrator rejected: ${parsed.failure.message}`)
                yield* say("config.rejected", { by: "file", source: "file", error: parsed.failure.message })
                continue
              }
              after.set(file, { text: text.value, orchestrator: parsed.success })
              yield* say("orchestrator.loaded", { id: parsed.success.id, file, enabled: parsed.success.spec.enabled ?? true, replaced: previous?.orchestrator !== undefined })
            }
            for (const [file, entry] of before) {
              if (!after.has(file) && entry.orchestrator) yield* say("orchestrator.removed", { id: entry.orchestrator.id, file })
            }
            yield* Ref.set(texts, after)
            const next = [...after.values()].flatMap((entry) => entry.orchestrator ? [entry.orchestrator] : [])
            const current = yield* SubscriptionRef.get(ref)
            if (next.length !== current.length || next.some((orchestrator, index) => orchestrator !== current[index])) yield* SubscriptionRef.set(ref, next)
          }).pipe(scanLock.withPermits(1))
        yield* scan(false)

        const find = (id: string) =>
          Effect.flatMap(SubscriptionRef.get(ref), (all) => {
            const found = all.find((orchestrator) => orchestrator.id === id)
            return found === undefined
              ? Effect.fail(new OrchestratorError({ message: `no orchestrator ${id} in ${dir} (have: ${all.map((o) => o.id).join(", ") || "none"})` }))
              : Effect.succeed(found)
          })

        const stateFile = (orchestrator: Orchestrator) => path.join(orchestrator.stateDir, "state.json")
        const readState = (orchestrator: Orchestrator) =>
          fs.exists(stateFile(orchestrator)).pipe(
            Effect.flatMap((exists) => exists ? fs.readFileString(stateFile(orchestrator)).pipe(Effect.flatMap(decodeState)) : Effect.succeed(EMPTY)),
            Effect.mapError((error) => new OrchestratorError({ message: `${stateFile(orchestrator)}: ${error.message}` }))
          )
        const writeState = (orchestrator: Orchestrator, state: State) =>
          Effect.gen(function*() {
            yield* fs.makeDirectory(orchestrator.stateDir, { recursive: true })
            const temp = `${stateFile(orchestrator)}.${yield* shortId}.tmp`
            yield* fs.writeFileString(temp, `${JSON.stringify(state, null, 2)}\n`)
            yield* fs.rename(temp, stateFile(orchestrator))
          }).pipe(Effect.mapError((error) => new OrchestratorError({ message: `write ${stateFile(orchestrator)}: ${error.message}` })))
        const append = (file: string, text: string) =>
          fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(file, text, { flag: "a" })),
            Effect.mapError((error) => new OrchestratorError({ message: `append ${file}: ${error.message}` }))
          )
        const readTail = (file: string, maxChars: number) =>
          fs.readFileString(file).pipe(Effect.map((text) => text.length > maxChars ? `…${text.slice(-maxChars)}` : text), Effect.orElseSucceed(() => "(none yet)"))

        const emit = <K extends keyof typeof events>(orchestrator: Orchestrator, name: K, data: (typeof events)[K]["Type"]) =>
          Schema.encodeUnknownEffect(events[name])(data).pipe(
            Effect.orDie, // the data is built here from the schema's own types
            Effect.flatMap((encoded) =>
              Effect.flatMap(shortId, (id) => makeEvent({ type: eventType({ id: orchestrator.id, events }, name), component: orchestrator.id, job: "tick", run: `tick-${id}`, data: encoded }))),
            Effect.flatMap(bus.publish)
          )

        const measureSeries = (orchestrator: Orchestrator): Effect.Effect<ReadonlyArray<{ readonly label: string; readonly value: number }>, OrchestratorError | JournalError> =>
          Effect.gen(function*() {
            const { measure } = orchestrator.spec
            if (measure.command !== undefined) {
              const [command, ...args] = measure.command
              const result = yield* exec(command!, args, orchestrator.measureCwd === undefined ? {} : { cwd: orchestrator.measureCwd }).pipe(
                Effect.mapError((error) => new OrchestratorError({ message: `measure: ${error.message}` }))
              )
              if (result.exitCode !== 0) return yield* new OrchestratorError({ message: `measure exited ${result.exitCode}: ${result.stderr.trim().slice(-300)}` })
              return parseSeries(result.stdout)
            }
            const field = measure.field!
            const Field = Schema.Struct({ [field]: Schema.Number })
            return (yield* bus.history).flatMap((event) =>
              event.type !== measure.event ? [] : Option.toArray(Schema.decodeUnknownOption(Field)(event.data)).map((data) => ({ label: event.at, value: data[field]! })))
          }).pipe(Effect.provideContext(services))

        const readContext = (orchestrator: Orchestrator): Effect.Effect<ReadonlyArray<string>> =>
          Effect.forEach(orchestrator.context, (entry) =>
            Effect.gen(function*() {
              const target = entry.latest
                ? yield* Effect.map(fs.readDirectory(path.dirname(entry.path)).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])), (names) => {
                  const glob = new Bun.Glob(path.basename(entry.path))
                  const last = naturalLast(names.filter((name) => glob.match(name)))
                  return last === undefined ? undefined : path.join(path.dirname(entry.path), last)
                })
                : entry.path
              if (target === undefined) return `## ${entry.label}\n(no file matches)`
              return `## ${entry.label}: ${target}\n${yield* readTail(target, entry.maxChars)}`
            }))

        const plannerSystem = (orchestrator: Orchestrator) => {
          const { spec } = orchestrator
          return [
            `You are the orchestrator for one goal: ${spec.goal}`,
            "You never do the work yourself. Each tick you read the state below and decide: dispatch the next step(s), wait, pause to ask Isaac, or say the goal is done.",
            `Progress is read as: ${spec.measure.label} (target ${spec.measure.target.op} ${spec.measure.target.value}).`,
            "Steps you may dispatch (input fields to fill in braces):",
            ...Object.entries(spec.steps).map(([name, step]) =>
              `- ${name} (${step.kind === "chef" ? `chef ${step.chef}, event ${step.request}` : "full agent session"}): ${step.description} Inputs: {${(orchestrator.inputs.get(name) ?? []).join(", ")}}${step.kind === "chef" ? " plus the request's own fields" : ""}`),
            ...(spec.planned?.length ? [`Chefs planned but not built yet (never dispatch them; say when one would help): ${spec.planned.join(", ")}.`] : []),
            "needs: list purchase, push or external when the next step needs Isaac's say-so (buying something, pushing or publishing, contacting anyone outside); otherwise an empty list.",
            "Dispatch only what the last results justify, and never a step whose earlier run is still pending.",
            ...(spec.system === undefined ? [] : ["", join(spec.system)])
          ].join("\n")
        }

        const locks = yield* SynchronizedRef.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map())
        const lockOf = (id: string) =>
          SynchronizedRef.modifyEffect(locks, (all) => {
            const found = all.get(id)
            return found !== undefined ? Effect.succeed([found, all] as const) : Effect.map(Semaphore.make(1), (made) => [made, new Map([...all, [id, made]])] as const)
          })

        const tickBody = (orchestrator: Orchestrator, mode: "live" | "dry"): Effect.Effect<Tick, OrchestratorError | JournalError> =>
          Effect.gen(function*() {
            const { spec } = orchestrator
            const live = mode === "live"
            const now = yield* Clock.currentTimeMillis
            const at = DateTime.formatIso(DateTime.makeUnsafe(now))
            const day = at.slice(0, 10)
            let state = yield* readState(orchestrator)
            const series = yield* measureSeries(orchestrator)
            const current = series.at(-1)
            const target = `${spec.measure.target.op} ${spec.measure.target.value}`
            const measure = { series, target, met: current !== undefined && meets(current.value, spec.measure.target) }
            const base = { id: orchestrator.id, measure, plan: undefined, cost: 0, dispatches: [] as Tick["dispatches"] }

            // Sessions dispatched earlier: finished when their done file exists or the session ended.
            const pending = yield* Effect.forEach(state.pending, (entry) =>
              Effect.gen(function*() {
                const doneFile = yield* fs.exists(entry.done).pipe(Effect.orElseSucceed(() => false))
                const sessionState = yield* sessions.state(entry.session)
                return { ...entry, finished: doneFile || !["running", "starting", "unknown"].includes(sessionState) }
              }))
            const finishedHours = pending.filter((entry) => entry.finished).reduce((sum, entry) => sum + (now - entry.startedAt) / 3_600_000, 0)
            const runningHours = pending.filter((entry) => !entry.finished).reduce((sum, entry) => sum + (now - entry.startedAt) / 3_600_000, 0)
            state = { ...state, pending: pending.filter((entry) => !entry.finished).map(({ finished: _, ...entry }) => entry), hours: { ...state.hours, [day]: (state.hours[day] ?? 0) + finishedHours } }
            const pendingView = pending.map((entry) => ({ step: entry.step, session: entry.session, finished: entry.finished }))

            const budget = spec.budget
            const spent = [
              ...(state.runs >= budget.maxRuns ? [{ rule: "budget runs", then: "pause" as const, why: `${state.runs} of ${budget.maxRuns} runs used` }] : []),
              ...(state.usd >= budget.maxUsd ? [{ rule: "budget usd", then: "pause" as const, why: `$${state.usd.toFixed(2)} of $${budget.maxUsd} used` }] : []),
              ...((state.hours[day] ?? 0) + runningHours >= budget.maxHoursPerDay
                ? [{ rule: "budget hours", then: "pause" as const, why: `${((state.hours[day] ?? 0) + runningHours).toFixed(1)} of ${budget.maxHoursPerDay} session hours today` }]
                : [])
            ]
            const stops = [...stopsHit(spec.stop, series, spec.measure.target), ...spent]

            const pause = (rule: string, then: string, why: string) =>
              Effect.gen(function*() {
                if (!live) return
                state = { ...state, paused: { why, rule, at } }
                yield* writeState(orchestrator, state)
                yield* append(path.join(orchestrator.stateDir, "log.ndjson"), `${JSON.stringify({ at, tick: state.ticks, paused: { rule, why } })}\n`)
                yield* append(orchestrator.handoff, `\n## ${at} paused (${rule})\n${why}\n`)
                yield* emit(orchestrator, "orchestrator.paused", { reportTo: orchestrator.reportTo, why, rule })
                yield* reporter.say(orchestrator.reportTo, `${orchestrator.id} ${then === "ask" ? "needs Isaac" : "paused"}: ${why}. Goal: ${spec.goal} Resume: atomic-agents orch resume ${orchestrator.id}`)
              })

            if (live && state.paused !== null) return { ...base, status: "paused" as const, stops, pending: pendingView, why: state.paused.why }
            if (live && stops.length > 0) {
              const first = stops[0]!
              yield* pause(first.rule, first.then, first.why)
              return { ...base, status: "stopped" as const, stops, pending: pendingView, why: first.why }
            }
            state = { ...state, ticks: state.ticks + 1 }
            if (live && state.pending.length > 0) {
              yield* writeState(orchestrator, state)
              return { ...base, status: "waiting" as const, stops, pending: pendingView, why: `waiting on ${state.pending.map((entry) => `${entry.step} (${entry.session})`).join(", ")}` }
            }

            // The one planning call.
            const relevant = new Set([orchestrator.id, ...spec.chefs])
            const recent = (yield* bus.history).filter((event) => relevant.has(event.component)).slice(-20)
              .map((event) => `${event.at} ${event.type} ${JSON.stringify(event.data).slice(0, 300)}`)
            const prompt = [
              `Now: ${at}`,
              `## Measure (${spec.measure.label}, oldest first)`,
              series.length === 0 ? "(no values yet)" : series.map((point) => `${point.label} ${point.value}`).join("\n"),
              `Target ${target}: ${measure.met ? "met" : "not met"}.`,
              ...(stops.length > 0 ? ["## Stop rules that hit (a live tick pauses before planning)", ...stops.map((stop) => `- ${stop.rule}: ${stop.why}`)] : []),
              "## Pending steps",
              pendingView.length === 0 ? "(none)" : pendingView.map((entry) => `- ${entry.step} session ${entry.session}: ${entry.finished ? "finished" : "running"}`).join("\n"),
              `## Budget: ${state.runs}/${budget.maxRuns} runs, $${state.usd.toFixed(2)}/$${budget.maxUsd}, ${((state.hours[day] ?? 0) + runningHours).toFixed(1)}/${budget.maxHoursPerDay} session hours today`,
              `## Handoff (${orchestrator.handoff})`,
              yield* readTail(orchestrator.handoff, 6000),
              "## Your log (last ticks)",
              (yield* readTail(path.join(orchestrator.stateDir, "log.ndjson"), 3000)),
              "## Recent events",
              recent.length === 0 ? "(none)" : recent.join("\n"),
              ...(yield* readContext(orchestrator))
            ].join("\n\n")
            const model = adapters.models.get(spec.adapter ?? "omp")!
            const viaAdapter = ModelRunner.of({ generate: (request) => model.generate(request).pipe(Effect.provideService(ModelRunner, runner), Effect.provideContext(services)) })
            const planned = yield* generateWithTools<Plan, never>({
              model: spec.model,
              system: plannerSystem(orchestrator),
              prompt,
              ...(spec.thinking ? { thinking: spec.thinking } : {})
            }, {
              tools: [],
              answer: Plan,
              answerExample: `{"decision": "dispatch" | "wait" | "pause" | "done", "why": "<one line>", "dispatch": [{"step": "<step>", "input": {...}}], "next": "<what the next tick should look for>", "needs": []}`,
              maxSteps: 2
            }).pipe(
              Effect.provideService(ModelRunner, viaAdapter),
              Effect.mapError((error) => new OrchestratorError({ message: `planning: ${error.message}` }))
            )
            const plan = planned.answer
            state = { ...state, usd: state.usd + planned.cost }

            const needsHit = spec.stop.flatMap((rule) => rule.when === "needs" && plan.needs.some((need) => rule.kinds.includes(need)) ? [rule] : [])
            interface Rendered {
              readonly name: string
              readonly input: Readonly<Record<string, unknown>>
              readonly spec: Step | undefined
              readonly kind: string
              readonly what: string
              readonly error?: string
            }
            const rendered = (plan.decision === "dispatch" ? plan.dispatch : []).map((entry): Rendered => {
              const step = spec.steps[entry.step]
              const fields: Readonly<Record<string, unknown>> = entry.input
              if (step === undefined) return { name: entry.step, input: fields, spec: step, kind: "?", what: "", error: `no step ${entry.step}` }
              if (step.kind === "chef") return { name: entry.step, input: fields, spec: step, kind: "chef", what: `${step.chef}/${step.request} ${JSON.stringify(entry.input)}` }
              const missing = (orchestrator.inputs.get(entry.step) ?? []).filter((name) => fields[name] === undefined)
              return {
                name: entry.step,
                input: fields,
                spec: step,
                kind: "session",
                what: `agent-session start --owner ${step.owner ?? orchestrator.reportTo} --model ${step.model} --thinking ${step.thinking} --title "${render(step.title, fields)}"${step.cwd ? ` --cwd ${step.cwd}` : ""}${step.maxTime ? ` --max-time ${step.maxTime}` : ""} "${render(join(step.task), fields)}" (done when ${render(step.done, fields)} exists)`,
                ...(missing.length > 0 ? { error: `missing input ${missing.join(", ")}` } : {})
              }
            })
            const dispatches = rendered.map(({ name, kind, what, error }) => ({ step: name, kind, what, ...(error === undefined ? {} : { error }) }))
            const result = { ...base, plan, cost: planned.cost, stops, pending: pendingView, dispatches }
            if (!live) return { ...result, status: "planned" as const, why: plan.why }

            if (needsHit.length > 0 || plan.decision === "pause" || plan.decision === "done") {
              const rule = needsHit.length > 0 ? `needs ${plan.needs.join(", ")}` : plan.decision
              yield* pause(rule, needsHit.length > 0 || plan.decision === "pause" ? "ask" : "pause", plan.why)
              return { ...result, status: "stopped" as const, why: plan.why }
            }
            const sent: Array<string> = []
            for (const entry of rendered) {
              const step = entry.spec
              if (entry.error !== undefined || step === undefined) {
                yield* Effect.logWarning(`${orchestrator.id}: skipped dispatch ${entry.name}: ${entry.error}`)
                continue
              }
              const fields = entry.input
              if (step.kind === "chef") {
                const chef = (yield* chefs.current).find((candidate) => candidate.id === step.chef)
                if (chef === undefined) {
                  yield* Effect.logWarning(`${orchestrator.id}: chef ${step.chef} is not loaded`)
                  continue
                }
                if (step.wait !== undefined && chef.asks !== undefined) {
                  const reply = yield* ask(chef, chef.asks, fields, `${step.wait} seconds`).pipe(Effect.provideService(EventBus, bus), Effect.result)
                  sent.push(`${entry.name}: ${Result.isSuccess(reply) ? `answered ${JSON.stringify(reply.success.data).slice(0, 200)}` : `no answer (${reply.failure.message})`}`)
                } else {
                  const schema = chef.events[step.request]!
                  const data = yield* Schema.encodeUnknownEffect(schema)({ requestId: yield* uuid, ...fields }).pipe(Effect.result)
                  if (Result.isFailure(data)) {
                    sent.push(`${entry.name}: bad input (${data.failure.message.slice(0, 200)})`)
                    continue
                  }
                  yield* bus.publish(yield* makeEvent({ type: `${chef.id}/${step.request}`, component: orchestrator.id, job: "tick", run: `tick-${yield* shortId}`, data: data.success }))
                  sent.push(`${entry.name}: ${chef.id}/${step.request}`)
                }
              } else {
                const session = yield* sessions.start({
                  owner: step.owner ?? orchestrator.reportTo,
                  model: step.model,
                  thinking: step.thinking,
                  title: render(step.title, fields),
                  ...(step.cwd ? { cwd: step.cwd } : {}),
                  ...(step.maxTime ? { maxTime: step.maxTime } : {}),
                  task: render(join(step.task), fields)
                })
                const done = yield* expandPath(render(step.done, fields), path.dirname(orchestrator.file)).pipe(
                  Effect.provideContext(services),
                  Effect.mapError((error) => new OrchestratorError({ message: `done path: ${error.message}` }))
                )
                state = { ...state, pending: [...state.pending, { step: entry.name, session, done: done.ok ? done.path : render(step.done, fields), startedAt: now }] }
                sent.push(`${entry.name}: session ${session}`)
              }
              state = { ...state, runs: state.runs + 1 }
            }
            yield* writeState(orchestrator, state)
            yield* append(path.join(orchestrator.stateDir, "log.ndjson"), `${JSON.stringify({ at, tick: state.ticks, measure: current ?? null, decision: plan.decision, why: plan.why, dispatched: sent, next: plan.next, cost: planned.cost })}\n`)
            yield* append(orchestrator.handoff, `\n## ${at} tick ${state.ticks}: ${plan.decision}\n- measure: ${current ? `${current.label} ${current.value}` : "none"} (target ${target})\n- why: ${plan.why}\n- dispatched: ${sent.join("; ") || "nothing"}\n- next: ${plan.next}\n`)
            yield* emit(orchestrator, "orchestrator.progress", {
              reportTo: orchestrator.reportTo,
              measure: { label: spec.measure.label, value: current?.value ?? null, target, met: measure.met },
              decision: plan.decision,
              why: plan.why,
              next: plan.next,
              dispatched: sent
            })
            return { ...result, status: "planned" as const, why: plan.why }
          })

        const tick = Effect.fn("Orchestrators.tick")(function*(id: string, mode: "live" | "dry") {
          const orchestrator = yield* find(id)
          const lock = yield* lockOf(id)
          const ran = yield* tickBody(orchestrator, mode).pipe(lock.withPermitsIfAvailable(1))
          return Option.getOrElse(ran, (): Tick => ({
            id, status: "busy", measure: { series: [], target: "", met: false }, stops: [], pending: [], plan: undefined, cost: 0, dispatches: [], why: "a tick is already running"
          }))
        })

        const pause = Effect.fn("Orchestrators.pause")(function*(id: string, why: string) {
          const orchestrator = yield* find(id)
          const state = yield* readState(orchestrator)
          const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
          yield* writeState(orchestrator, { ...state, paused: { why, rule: "manual", at } })
          yield* emit(orchestrator, "orchestrator.paused", { reportTo: orchestrator.reportTo, why, rule: "manual" })
        })
        const resume = Effect.fn("Orchestrators.resume")(function*(id: string, by: string) {
          const orchestrator = yield* find(id)
          const state = yield* readState(orchestrator)
          // A resume opens a new budget window: runs and USD count from zero again.
          yield* writeState(orchestrator, { ...state, paused: null, runs: 0, usd: 0 })
          yield* emit(orchestrator, "orchestrator.resumed", { by })
        })

        return Orchestrators.of({
          dir,
          current: SubscriptionRef.get(ref),
          changes: SubscriptionRef.changes(ref),
          reload: scan(true),
          tick: (id, mode) => tick(id, mode).pipe(Effect.provideContext(services)),
          state: (id) => Effect.flatMap(find(id), readState),
          pause,
          resume
        })
      })
    )

  static readonly layer = Orchestrators.make()

  /** Background layer: re-read the files every second and tick every enabled orchestrator on its cadence. */
  static readonly layerSchedule = Layer.effectDiscard(Effect.gen(function*() {
    const orchestrators = yield* Orchestrators
    const background = yield* Background
    yield* FiberSet.run(background, orchestrators.reload.pipe(Effect.repeat(Schedule.spaced("1 second"))))
    yield* FiberSet.run(background, orchestrators.changes.pipe(
      Stream.map((all) => all.filter((orchestrator) => orchestrator.spec.enabled !== false)),
      Stream.switchMap((enabled) =>
        Stream.fromEffectDrain(Effect.forEach(enabled, (orchestrator) => {
          const once = orchestrators.tick(orchestrator.id, "live").pipe(
            Effect.tap((result) => Effect.logInfo(`${orchestrator.id} tick: ${result.status}: ${result.why}`)),
            Effect.catchTag("OrchestratorError", (error) => Effect.logWarning(`${orchestrator.id} tick failed: ${error.message}`))
          )
          const cadence = orchestrator.spec.cadence
          const armed: Effect.Effect<unknown, JournalError> = cadence === "loop"
            ? Effect.repeat(once, Schedule.spaced(`${orchestrator.spec.loopSeconds ?? 60} seconds`))
            : Effect.schedule(once, Schedule.cron(cadence.cron)).pipe(Effect.catchTag("CronParseError", (error) => Effect.logError(error.message)))
          return Effect.logInfo(`armed orchestrator ${orchestrator.id} ${cadence === "loop" ? `loop every ${orchestrator.spec.loopSeconds ?? 60}s` : `cron "${cadence.cron}"`}`).pipe(
            Effect.andThen(armed)
          )
        }, { concurrency: "unbounded", discard: true }))),
      Stream.runDrain
    ))
  }))
}
