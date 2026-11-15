import { Cause, Clock, Context, Effect, Exit, FiberSet, FileSystem, Layer, Schedule, Schema, Semaphore, Stream } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { Background } from "./Background.ts"
import { Components, Trigger } from "./Component.ts"
import { EventBus, Home, JobFailed, JobStarted, JobSucceeded, JournalError, Lifecycle, makeEvent } from "./Event.ts"
import { runId } from "./Id.ts"
import type { ModelRunner } from "./Model.ts"
import { effective, Settings } from "./Settings.ts"

export class UnknownJob extends Schema.TaggedError<UnknownJob>()("UnknownJob", {
  message: Schema.String
}) {}

export class ComponentDisabled extends Schema.TaggedError<ComponentDisabled>()("ComponentDisabled", {
  message: Schema.String
}) {}

export interface RunOptions {
  /** Bake-off override; defaults to the model in config.json, else the component's `agent.model`. */
  readonly model?: string
}

export interface RunResult {
  readonly run: string
  readonly ok: boolean
}

const encodeLifecycle = Schema.encodeEffect(Lifecycle)

/**
 * Runs component jobs: one at a time per component (a specialist is one worker), every run wrapped
 * in the `Lifecycle` events (`job.started` / `job.succeeded` / `job.failed`) so any subscriber can follow
 * any component without knowing its schemas. Each run reads the config in force, so config.json edits
 * apply to the next run without a restart. Component tools are built once, with this layer.
 */
export class Runner extends Context.Service<Runner, {
  run(component: string, job: string, input: unknown, options?: RunOptions): Effect.Effect<RunResult, UnknownJob | ComponentDisabled | JournalError>
}>()("atomic-agents/Runner") {
  static readonly layer = Layer.effect(
    Runner,
    Effect.gen(function*() {
      const settings = yield* Settings
      const bus = yield* EventBus
      const home = yield* Home
      const fs = yield* FileSystem.FileSystem
      const services = yield* Effect.context<ModelRunner | BunServices>()
      const registry = yield* Effect.forEach(yield* Components, (component) =>
        Effect.gen(function*() {
          return { component, jobs: yield* component.build, lock: yield* Semaphore.make(1) }
        }))

      const run = Effect.fn("Runner.run")(function*(componentId: string, jobId: string, input: unknown, options: RunOptions = {}) {
        const entry = registry.find((candidate) => candidate.component.id === componentId)
        const job = entry?.jobs.find((candidate) => candidate.id === jobId)
        if (entry === undefined || job === undefined) {
          return yield* new UnknownJob({ message: `no job ${componentId}/${jobId}` })
        }
        const { component, lock } = entry
        const resolved = effective(component, yield* settings.current)
        if (!resolved.enabled) return yield* new ComponentDisabled({ message: `${component.id} is disabled in ${settings.file}` })
        const run = yield* runId
        const runDir = home.runDir(component.id, run)
        const stateDir = home.stateDir(component.id)
        const model = options.model ?? resolved.agent.model
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
          yield* lifecycle(JobStarted.make({ input, model }))
          const outcome = yield* job.start(input, { ...envelope, runDir, stateDir, model, agent: resolved.agent, publish }).pipe(
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
   * Background layer: arms every OnEvent and Cron trigger of the components in the `Background` set.
   * Event triggers stay subscribed and skip events while their component is disabled; crons follow
   * config.json and are re-armed whenever the enabled set or an expression changes. A trigger that
   * cannot run is logged; a `JournalError` ends serve.
   */
  static readonly layerTriggers = Layer.effectDiscard(Effect.gen(function*() {
    const runner = yield* Runner
    const components = yield* Components
    const settings = yield* Settings
    const bus = yield* EventBus
    const background = yield* Background

    const runLogged = (component: string, job: string, input: unknown) =>
      runner.run(component, job, input).pipe(Effect.catchTags({
        UnknownJob: (error) => Effect.logWarning(error.message),
        ComponentDisabled: (error) => Effect.logInfo(error.message)
      }))

    for (const component of components) {
      for (const job of component.jobs) {
        for (const trigger of job.triggers) {
          if (!Trigger.$is("OnEvent")(trigger)) continue
          // Subscribed before the layer is up: a request emitted right after serve starts is not missed.
          yield* FiberSet.run(background, (yield* bus.listen).pipe(
            Stream.filter((event) => event.type === trigger.type),
            Stream.runForEach((event) =>
              Effect.gen(function*() {
                if (!effective(component, yield* settings.current).enabled) return yield* Effect.logInfo(`${component.id} is disabled, skipped ${event.type}`)
                yield* runLogged(component.id, job.id, event.data)
              }))
          ))
          yield* Effect.logInfo(`armed ${component.id}/${job.id} on ${trigger.type}`)
        }
      }
    }

    yield* FiberSet.run(background, settings.changes.pipe(
      Stream.map((current) =>
        components.flatMap((component) => {
          const resolved = effective(component, current)
          if (!resolved.enabled) return []
          return component.jobs.flatMap((job) =>
            job.triggers.flatMap((trigger) =>
              Trigger.$is("Cron")(trigger) ? [{ component: component.id, job: job.id, cron: resolved.cron(job.id, trigger.cron), input: trigger.input }] : []))
        })),
      // Plans are plain arrays of plain objects: `Equal.equals` compares them structurally.
      Stream.changes,
      Stream.switchMap((plan) =>
        Stream.fromEffectDrain(Effect.forEach(plan, (entry) =>
          Effect.logInfo(`armed ${entry.component}/${entry.job} cron "${entry.cron}"`).pipe(Effect.andThen(entry.input.pipe(
            Effect.flatMap((input) => runLogged(entry.component, entry.job, input)),
            Effect.schedule(Schedule.cron(entry.cron)),
            // config.json crons are validated before they apply; this catches a bad code default.
            Effect.catchTag("CronParseError", (error) => Effect.logError(`bad cron "${entry.cron}" for ${entry.component}/${entry.job}: ${error.message}`))
          ))), { concurrency: "unbounded", discard: true }))),
      Stream.runDrain
    ))
  }))
}
