import { Cause, Context, Effect, FileSystem, Layer, Schedule, Schema, Semaphore, Stream } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { Components, type EventSchemas, type JobContext } from "./Component.ts"
import { EventBus, Home, JournalError, makeEvent } from "./Event.ts"
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

/**
 * Runs component jobs: one at a time per component (a specialist is one worker), every run wrapped
 * in `job.started` / `job.succeeded` / `job.failed` events so any subscriber can follow any component
 * without knowing its schemas. Each run reads the config in force, so config.json edits apply to the
 * next run without a restart.
 */
export class Runner extends Context.Service<Runner, {
  run(component: string, job: string, input: unknown, options?: RunOptions): Effect.Effect<RunResult, UnknownJob | ComponentDisabled | JournalError>
  /** Watch config.json, arm every Cron and OnEvent trigger of the enabled components; runs until interrupted. */
  readonly serve: Effect.Effect<never, JournalError>
}>()("atomic-agents/Runner") {
  static readonly layer = Layer.effect(
    Runner,
    Effect.gen(function*() {
      const components = yield* Components
      const settings = yield* Settings
      const bus = yield* EventBus
      const home = yield* Home
      const fs = yield* FileSystem.FileSystem
      const services = yield* Effect.context<ModelRunner | BunServices>()
      const locks = new Map(yield* Effect.forEach(components, (component) =>
        Semaphore.make(1).pipe(Effect.map((lock) => [component.id, lock] as const))))

      const runtimeEvent = (component: string, job: string, run: string, name: string, data: unknown) =>
        makeEvent({ type: `${component}/${name}`, component, job, run, data }).pipe(Effect.flatMap(bus.publish))

      const run = Effect.fn("Runner.run")(function*(componentId: string, jobId: string, input: unknown, options: RunOptions = {}) {
        const component = components.find((candidate) => candidate.id === componentId)
        const job = component?.jobs.find((candidate) => candidate.id === jobId)
        if (component === undefined || job === undefined) {
          return yield* new UnknownJob({ message: `no job ${componentId}/${jobId}` })
        }
        const resolved = effective(component, yield* settings.current)
        if (!resolved.enabled) return yield* new ComponentDisabled({ message: `${component.id} is disabled in ${settings.file}` })
        const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${crypto.randomUUID().slice(0, 8)}`
        const runDir = home.runDir(component.id, runId)
        const model = options.model ?? resolved.agent.model
        const context: JobContext<EventSchemas> = {
          component: component.id,
          job: job.id,
          run: runId,
          runDir,
          model,
          agent: resolved.agent,
          emit: (name, data) => {
            const schema = component.events[name]
            if (schema === undefined) return Effect.die(new Error(`${component.id} does not declare event ${name}`))
            return Schema.encodeUnknownEffect(schema)(data).pipe(
              Effect.flatMap((encoded) => makeEvent({ type: `${component.id}/${name}`, component: component.id, job: job.id, run: runId, data: encoded })),
              Effect.flatMap(bus.publish)
            )
          }
        }
        const started = Date.now()
        const body = Effect.gen(function*() {
          yield* fs.makeDirectory(runDir, { recursive: true }).pipe(Effect.orDie)
          yield* runtimeEvent(component.id, job.id, runId, "job.started", { input, model })
          const outcome = yield* job.start(input, context).pipe(Effect.provideContext(services), Effect.exit)
          const seconds = (Date.now() - started) / 1000
          if (outcome._tag === "Success") {
            yield* runtimeEvent(component.id, job.id, runId, "job.succeeded", { model, seconds })
            return { run: runId, ok: true }
          }
          const failure = Cause.findErrorOption(outcome.cause)
          yield* runtimeEvent(component.id, job.id, runId, "job.failed", {
            model,
            seconds,
            error: failure._tag === "Some" ? failure.value._tag : "Defect",
            message: failure._tag === "Some" ? failure.value.message : Cause.pretty(outcome.cause).slice(0, 2000)
          })
          return { run: runId, ok: false }
        })
        return yield* locks.get(component.id)!.withPermits(1)(body)
      })

      const serve = Effect.gen(function*() {
        yield* settings.serve.pipe(Effect.forkScoped)
        // Event triggers stay subscribed; a component disabled in config.json skips the event.
        for (const component of components) {
          for (const job of component.jobs) {
            for (const trigger of job.triggers) {
              if (trigger._tag !== "OnEvent") continue
              yield* bus.subscribe.pipe(
                Stream.filter((event) => event.type === trigger.type),
                Stream.runForEach((event) =>
                  Effect.gen(function*() {
                    if (!effective(component, yield* settings.current).enabled) return yield* Effect.logInfo(`${component.id} is disabled, skipped ${event.type}`)
                    yield* run(component.id, job.id, event.data)
                  }).pipe(Effect.catch((error) => Effect.logError("event run", error)))),
                Effect.forkScoped
              )
              yield* Effect.logInfo(`armed ${component.id}/${job.id} on ${trigger.type}`)
            }
          }
        }
        // Crons follow config.json: re-armed whenever the enabled set or an expression changes.
        yield* settings.changes.pipe(
          Stream.map((current) =>
            components.flatMap((component) => {
              const resolved = effective(component, current)
              if (!resolved.enabled) return []
              return component.jobs.flatMap((job) =>
                job.triggers.flatMap((trigger) =>
                  trigger._tag === "Cron" ? [{ component: component.id, job: job.id, cron: resolved.cron(job.id, trigger.cron), input: trigger.input }] : []))
            })),
          Stream.changesWith((a, b) => a.map((entry) => `${entry.component}/${entry.job} ${entry.cron}`).join("\n") === b.map((entry) => `${entry.component}/${entry.job} ${entry.cron}`).join("\n")),
          Stream.switchMap((plan) =>
            Stream.fromEffectDrain(Effect.forEach(plan, (entry) =>
              Effect.logInfo(`armed ${entry.component}/${entry.job} cron "${entry.cron}"`).pipe(Effect.andThen(entry.input.pipe(
                Effect.flatMap((input) => run(entry.component, entry.job, input)),
                Effect.catch((error) => Effect.logError("cron run", error)),
                Effect.schedule(Schedule.cron(entry.cron)),
                Effect.catch((error) => Effect.logError(`bad cron ${entry.cron}`, error))
              ))), { concurrency: "unbounded", discard: true }))),
          Stream.runDrain,
          Effect.forkScoped
        )
        return yield* Effect.never
      }).pipe(Effect.scoped)

      return Runner.of({ run, serve })
    })
  )
}
