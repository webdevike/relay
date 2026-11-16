import { Cause, Clock, Context, Effect, Exit, FiberSet, FileSystem, Layer, Schedule, Schema, Semaphore, Stream, SynchronizedRef } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { Background } from "./Background.ts"
import { Agents } from "./Agent.ts"
import { type ToolMode, Trigger } from "./Component.ts"
import { EventBus, Home, JobFailed, JobStarted, JobSucceeded, JournalError, Lifecycle, makeEvent } from "./Event.ts"
import { runId } from "./Id.ts"
import type { ModelRunner } from "./Model.ts"
import { events as runtimeEvents, publishRuntime, RUNTIME } from "./RuntimeEvents.ts"
import { effective, Settings } from "./Settings.ts"

const RUN_REQUESTED = `${RUNTIME}/run.requested`
const decodeRunRequested = Schema.decodeUnknownEffect(runtimeEvents["run.requested"])

export class UnknownJob extends Schema.TaggedError<UnknownJob>()("UnknownJob", {
  message: Schema.String
}) {}

export class ComponentDisabled extends Schema.TaggedError<ComponentDisabled>()("ComponentDisabled", {
  message: Schema.String
}) {}

/** A tool mode asked of an agent whose model calls no tools. */
export class NoToolMode extends Schema.TaggedError<NoToolMode>()("NoToolMode", {
  message: Schema.String
}) {}

export interface RunOptions {
  /** Bake-off override; defaults to the model in config.json, else the component's `agent.model`. */
  readonly model?: string
  /** Bake-off override; defaults to the tool mode in config.json, else the agent file's. Only for an agent with tools. */
  readonly toolMode?: ToolMode
  /** The request this run answers (`atomic-agents/run.requested`); recorded on `job.started`. */
  readonly requestId?: string
}

export interface RunResult {
  readonly run: string
  readonly ok: boolean
}

const encodeLifecycle = Schema.encodeEffect(Lifecycle)

/**
 * Runs agent jobs: one at a time per agent (a specialist is one worker), every run wrapped in the
 * `Lifecycle` events (`job.started` / `job.succeeded` / `job.failed`) so any subscriber can follow any
 * agent without knowing its schemas. Each run reads the agents and the config in force, so an agent file or
 * config.json edit applies to the next run without a restart.
 */
export class Runner extends Context.Service<Runner, {
  run(component: string, job: string, input: unknown, options?: RunOptions): Effect.Effect<RunResult, UnknownJob | ComponentDisabled | NoToolMode | JournalError>
}>()("atomic-agents/Runner") {
  static readonly layer = Layer.effect(
    Runner,
    Effect.gen(function*() {
      const settings = yield* Settings
      const bus = yield* EventBus
      const home = yield* Home
      const fs = yield* FileSystem.FileSystem
      const agents = yield* Agents
      const services = yield* Effect.context<ModelRunner | BunServices>()
      // By agent id, so a reloaded agent keeps its lock: a run in flight finishes before the new version's first.
      const locks = yield* SynchronizedRef.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map())
      const lockOf = (id: string) =>
        SynchronizedRef.modifyEffect(locks, (all) => {
          const found = all.get(id)
          return found !== undefined
            ? Effect.succeed([found, all] as const)
            : Effect.map(Semaphore.make(1), (made) => [made, new Map([...all, [id, made]])] as const)
        })

      const run = Effect.fn("Runner.run")(function*(componentId: string, jobId: string, input: unknown, options: RunOptions = {}) {
        const component = (yield* agents.current).find((candidate) => candidate.id === componentId)
        const job = component?.runnable.find((candidate) => candidate.id === jobId)
        if (component === undefined || job === undefined) {
          return yield* new UnknownJob({ message: `no job ${componentId}/${jobId}` })
        }
        const lock = yield* lockOf(component.id)
        const resolved = effective(component, yield* settings.current)
        if (!resolved.enabled) return yield* new ComponentDisabled({ message: `${component.id} is disabled in ${settings.file}` })
        const run = yield* runId
        const runDir = home.runDir(component.id, run)
        const stateDir = home.stateDir(component.id)
        const model = options.model ?? resolved.agent.model
        if (options.toolMode !== undefined && resolved.agent.toolMode === undefined) {
          return yield* new NoToolMode({ message: `${component.id} calls no tools, so it has no tool mode` })
        }
        const toolMode = resolved.agent.toolMode === undefined ? undefined : options.toolMode ?? resolved.agent.toolMode
        const modes = toolMode === undefined ? {} : { toolMode }
        const envelope = { component: component.id, job: job.id, run }
        const publish = (name: string, data: unknown) =>
          makeEvent({ ...envelope, type: `${component.id}/${name}`, data }).pipe(Effect.flatMap(bus.publish))
        const lifecycle = (event: Lifecycle) =>
          encodeLifecycle(event).pipe(
            Effect.mapError((cause) => new JournalError({ message: `encode ${event._tag}`, cause })),
            Effect.flatMap((data) => publish(event._tag, data))
          )
        const body = Effect.gen(function*() {
          const started = yield* Clock.currentTimeMillis
          const seconds = Effect.map(Clock.currentTimeMillis, (now) => (now - started) / 1000)
          yield* Effect.forEach([runDir, stateDir], (dir) =>
            fs.makeDirectory(dir, { recursive: true }).pipe(
              Effect.mapError((cause) => new JournalError({ message: `create ${dir}`, cause }))
            ), { discard: true })
          yield* lifecycle(JobStarted.make({ input, model, ...modes, ...(options.requestId === undefined ? {} : { requestId: options.requestId }) }))
          const outcome = yield* job.start(input, { ...envelope, runDir, stateDir, model, ...modes, agent: resolved.agent, publish }).pipe(
            Effect.provideContext(services),
            Effect.exit
          )
          if (Exit.isSuccess(outcome)) {
            yield* lifecycle(JobSucceeded.make({ model, seconds: yield* seconds }))
            return { run, ok: true }
          }
          const failure = Cause.findErrorOption(outcome.cause)
          yield* lifecycle(JobFailed.make({
            model,
            seconds: yield* seconds,
            error: failure._tag === "Some" ? failure.value._tag : "Defect",
            message: failure._tag === "Some" ? failure.value.message : Cause.pretty(outcome.cause).slice(0, 2000)
          }))
          return { run, ok: false }
        })
        return yield* lock.withPermits(1)(body)
      })

      return Runner.of({ run })
    })
  )

  /**
   * Background layer: arms every OnEvent and Cron trigger of the agents in force, in the `Background` set.
   * One bus subscription serves every event trigger: each event looks up the agents and config in force,
   * so an agent loaded or edited later is armed without re-subscribing, and a disabled agent skips it. Crons
   * are re-armed whenever the agents, the enabled set or an expression changes. A trigger that cannot run
   * is logged; a `JournalError` ends serve.
   */
  static readonly layerTriggers = Layer.effectDiscard(Effect.gen(function*() {
    const runner = yield* Runner
    const agents = yield* Agents
    const settings = yield* Settings
    const bus = yield* EventBus
    const background = yield* Background

    const runLogged = (component: string, job: string, input: unknown, options?: RunOptions) =>
      runner.run(component, job, input, options).pipe(Effect.catchTags({
        UnknownJob: (error) => Effect.logWarning(error.message),
        ComponentDisabled: (error) => Effect.logInfo(error.message),
        NoToolMode: (error) => Effect.logWarning(error.message)
      }))

    /** A caller's `run.requested`: the run carries its `requestId`; one that cannot start is a `run.rejected` the caller sees. */
    const runRequested = (data: unknown) =>
      decodeRunRequested(data).pipe(
        Effect.flatMap((request) =>
          runner.run(request.agent, request.job, request.input, { requestId: request.requestId }).pipe(
            Effect.asVoid,
            // A journal failure ends serve like any other; anything else means the run never started.
            Effect.catch((error) =>
              error._tag === "JournalError"
                ? Effect.fail(error)
                : publishRuntime(bus, "run.rejected", { requestId: request.requestId, agent: request.agent, error: error.message }, "runner"))
          )),
        Effect.catchTag("SchemaError", (error) => Effect.logWarning(`bad ${RUN_REQUESTED}: ${error.message}`))
      )

    // Subscribed before the layer is up: a request emitted right after serve starts is not missed.
    yield* FiberSet.run(background, (yield* bus.listen).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function*() {
          if (event.type === RUN_REQUESTED) return yield* FiberSet.run(background, runRequested(event.data))
          const current = yield* settings.current
          for (const agent of yield* agents.current) {
            for (const job of agent.jobs) {
              if (!job.triggers.some((trigger) => Trigger.$is("OnEvent")(trigger) && trigger.type === event.type)) continue
              if (!effective(agent, current).enabled) yield* Effect.logInfo(`${agent.id} is disabled, skipped ${event.type}`)
              // Each run in its own fiber: a slow agent never holds up another agent's events (the runner's lock orders an agent's own).
              else yield* FiberSet.run(background, runLogged(agent.id, job.id, event.data))
            }
          }
        }))
    ))
    yield* FiberSet.run(background, agents.changes.pipe(
      Stream.map((all) =>
        all.flatMap((agent) => agent.jobs.flatMap((job) => job.triggers.flatMap((trigger) => Trigger.$is("OnEvent")(trigger) ? [`${agent.id}/${job.id} on ${trigger.type}`] : [])))),
      Stream.changes,
      Stream.runForEach((armed) => Effect.forEach(armed, (line) => Effect.logInfo(`armed ${line}`), { discard: true }))
    ))

    yield* FiberSet.run(background, Stream.zipLatest(agents.changes, settings.changes).pipe(
      Stream.map(([all, current]) =>
        all.flatMap((agent) => {
          const resolved = effective(agent, current)
          if (!resolved.enabled) return []
          return agent.jobs.flatMap((job) =>
            job.triggers.flatMap((trigger) =>
              Trigger.$is("Cron")(trigger) ? [{ component: agent.id, job: job.id, cron: resolved.cron(job.id, trigger.cron), input: trigger.input }] : []))
        })),
      // Plans are plain arrays of plain objects: `Equal.equals` compares them structurally (a reloaded agent's new input effect re-arms it).
      Stream.changes,
      Stream.switchMap((plan) =>
        Stream.fromEffectDrain(Effect.forEach(plan, (entry) =>
          Effect.logInfo(`armed ${entry.component}/${entry.job} cron "${entry.cron}"`).pipe(Effect.andThen(entry.input.pipe(
            Effect.flatMap((input) => runLogged(entry.component, entry.job, input)),
            Effect.schedule(Schedule.cron(entry.cron)),
            // config.json and agent file crons are validated before they apply; this catches a bad code default.
            Effect.catchTag("CronParseError", (error) => Effect.logError(`bad cron "${entry.cron}" for ${entry.component}/${entry.job}: ${error.message}`))
          ))), { concurrency: "unbounded", discard: true }))),
      Stream.runDrain
    ))
  }))
}
