import { Cause, Clock, Context, Effect, Exit, FiberSet, FileSystem, Layer, Schedule, Schema, Semaphore, Stream, SynchronizedRef } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { Background } from "./Background.ts"
import { Chefs } from "./Chef.ts"
import { Trigger } from "./Component.ts"
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
 * Runs chef jobs: one at a time per chef (a specialist is one worker), every run wrapped in the
 * `Lifecycle` events (`job.started` / `job.succeeded` / `job.failed`) so any subscriber can follow any
 * chef without knowing its schemas. Each run reads the chefs and the config in force, so a chef file or
 * config.json edit applies to the next run without a restart.
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
      const chefs = yield* Chefs
      const services = yield* Effect.context<ModelRunner | BunServices>()
      // By chef id, so a reloaded chef keeps its lock: a run in flight finishes before the new version's first.
      const locks = yield* SynchronizedRef.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map())
      const lockOf = (id: string) =>
        SynchronizedRef.modifyEffect(locks, (all) => {
          const found = all.get(id)
          return found !== undefined
            ? Effect.succeed([found, all] as const)
            : Effect.map(Semaphore.make(1), (made) => [made, new Map([...all, [id, made]])] as const)
        })

      const run = Effect.fn("Runner.run")(function*(componentId: string, jobId: string, input: unknown, options: RunOptions = {}) {
        const component = (yield* chefs.current).find((candidate) => candidate.id === componentId)
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
   * Background layer: arms every OnEvent and Cron trigger of the chefs in force, in the `Background` set.
   * One bus subscription serves every event trigger: each event looks up the chefs and config in force,
   * so a chef loaded or edited later is armed without re-subscribing, and a disabled chef skips it. Crons
   * are re-armed whenever the chefs, the enabled set or an expression changes. A trigger that cannot run
   * is logged; a `JournalError` ends serve.
   */
  static readonly layerTriggers = Layer.effectDiscard(Effect.gen(function*() {
    const runner = yield* Runner
    const chefs = yield* Chefs
    const settings = yield* Settings
    const bus = yield* EventBus
    const background = yield* Background

    const runLogged = (component: string, job: string, input: unknown) =>
      runner.run(component, job, input).pipe(Effect.catchTags({
        UnknownJob: (error) => Effect.logWarning(error.message),
        ComponentDisabled: (error) => Effect.logInfo(error.message)
      }))

    // Subscribed before the layer is up: a request emitted right after serve starts is not missed.
    yield* FiberSet.run(background, (yield* bus.listen).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function*() {
          const current = yield* settings.current
          for (const chef of yield* chefs.current) {
            for (const job of chef.jobs) {
              if (!job.triggers.some((trigger) => Trigger.$is("OnEvent")(trigger) && trigger.type === event.type)) continue
              if (!effective(chef, current).enabled) yield* Effect.logInfo(`${chef.id} is disabled, skipped ${event.type}`)
              // Each run in its own fiber: a slow chef never holds up another chef's events (the runner's lock orders a chef's own).
              else yield* FiberSet.run(background, runLogged(chef.id, job.id, event.data))
            }
          }
        }))
    ))
    yield* FiberSet.run(background, chefs.changes.pipe(
      Stream.map((all) =>
        all.flatMap((chef) => chef.jobs.flatMap((job) => job.triggers.flatMap((trigger) => Trigger.$is("OnEvent")(trigger) ? [`${chef.id}/${job.id} on ${trigger.type}`] : [])))),
      Stream.changes,
      Stream.runForEach((armed) => Effect.forEach(armed, (line) => Effect.logInfo(`armed ${line}`), { discard: true }))
    ))

    yield* FiberSet.run(background, Stream.zipLatest(chefs.changes, settings.changes).pipe(
      Stream.map(([all, current]) =>
        all.flatMap((chef) => {
          const resolved = effective(chef, current)
          if (!resolved.enabled) return []
          return chef.jobs.flatMap((job) =>
            job.triggers.flatMap((trigger) =>
              Trigger.$is("Cron")(trigger) ? [{ component: chef.id, job: job.id, cron: resolved.cron(job.id, trigger.cron), input: trigger.input }] : []))
        })),
      // Plans are plain arrays of plain objects: `Equal.equals` compares them structurally (a reloaded chef's new input effect re-arms it).
      Stream.changes,
      Stream.switchMap((plan) =>
        Stream.fromEffectDrain(Effect.forEach(plan, (entry) =>
          Effect.logInfo(`armed ${entry.component}/${entry.job} cron "${entry.cron}"`).pipe(Effect.andThen(entry.input.pipe(
            Effect.flatMap((input) => runLogged(entry.component, entry.job, input)),
            Effect.schedule(Schedule.cron(entry.cron)),
            // config.json and chef file crons are validated before they apply; this catches a bad code default.
            Effect.catchTag("CronParseError", (error) => Effect.logError(`bad cron "${entry.cron}" for ${entry.component}/${entry.job}: ${error.message}`))
          ))), { concurrency: "unbounded", discard: true }))),
      Stream.runDrain
    ))
  }))
}
