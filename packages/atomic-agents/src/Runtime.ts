import { Cause, Context, Effect, FileSystem, Layer, Schedule, Schema, Semaphore, Stream } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import type { EventSchemas, JobContext, Registered } from "./Component.ts"
import { EventBus, Home, JournalError, makeEvent } from "./Event.ts"
import type { ModelRunner } from "./Model.ts"

export class UnknownJob extends Schema.TaggedError<UnknownJob>()("UnknownJob", {
  message: Schema.String
}) {}

export interface RunOptions {
  /** Bake-off override; defaults to the component's `agent.model`. */
  readonly model?: string
}

export interface RunResult {
  readonly run: string
  readonly ok: boolean
}

/** The registered components, provided once by the host process (CLI, Relay host, tests). */
export class Components extends Context.Service<Components, ReadonlyArray<Registered>>()("atomic-agents/Components") {}

/**
 * Runs component jobs: one at a time per component (a specialist is one worker), every run wrapped
 * in `job.started` / `job.succeeded` / `job.failed` events so any subscriber can follow any component
 * without knowing its schemas.
 */
export class Runner extends Context.Service<Runner, {
  run(component: string, job: string, input: unknown, options?: RunOptions): Effect.Effect<RunResult, UnknownJob | JournalError>
  /** Arm every Cron and OnEvent trigger; runs until interrupted. */
  readonly serve: Effect.Effect<never, JournalError>
}>()("atomic-agents/Runner") {
  static readonly layer = Layer.effect(
    Runner,
    Effect.gen(function*() {
      const components = yield* Components
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
        const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${crypto.randomUUID().slice(0, 8)}`
        const runDir = home.runDir(component.id, runId)
        const model = options.model ?? component.agent.model
        const context: JobContext<EventSchemas> = {
          component: component.id,
          job: job.id,
          run: runId,
          runDir,
          model,
          agent: component.agent,
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
        for (const component of components) {
          for (const job of component.jobs) {
            for (const trigger of job.triggers) {
              if (trigger._tag === "Cron") {
                yield* trigger.input.pipe(
                  Effect.flatMap((input) => run(component.id, job.id, input)),
                  Effect.catch((error) => Effect.logError("cron run", error)),
                  Effect.schedule(Schedule.cron(trigger.cron)),
                  Effect.catch((error) => Effect.logError(`bad cron ${trigger.cron}`, error)),
                  Effect.forkScoped
                )
                yield* Effect.logInfo(`armed ${component.id}/${job.id} cron "${trigger.cron}"`)
              } else if (trigger._tag === "OnEvent") {
                yield* bus.subscribe.pipe(
                  Stream.filter((event) => event.type === trigger.type),
                  Stream.runForEach((event) =>
                    run(component.id, job.id, event.data).pipe(Effect.catch((error) => Effect.logError("event run", error)))),
                  Effect.forkScoped
                )
                yield* Effect.logInfo(`armed ${component.id}/${job.id} on ${trigger.type}`)
              }
            }
          }
        }
        return yield* Effect.never
      }).pipe(Effect.scoped)

      return Runner.of({ run, serve })
    })
  )
}
