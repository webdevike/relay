import { Context, Cron, Effect, FileSystem, Layer, Path, Result, Schedule, Schema, Semaphore, Stream, SubscriptionRef } from "effect"
import { type Agent, Components, type Registered } from "./Component.ts"
import { EventBus, Home, type JournalError, makeEvent } from "./Event.ts"

/**
 * The consumer side: `<home>/config.json` (Relay's data dir) says which built-in components run and
 * with which model, candidates, thinking and crons, plus where the OpenRouter key file is. Absent
 * keys fall back to the code defaults in `define()`, so a bake-off winner changes config, not code.
 * The service applies edits live; every applied change is a `atomic-agents/config.changed` event.
 */
const Thinking = Schema.Literals(["off", "minimal", "low", "medium", "high"])

export const ComponentSettings = Schema.Struct({
  /** Default true. A disabled component's triggers do not fire and manual runs are refused. */
  enabled: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.NonEmptyString),
  candidates: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  thinking: Schema.optionalKey(Thinking),
  /** Job id → cron expression replacing that job's code cron. */
  cron: Schema.optionalKey(Schema.Record(Schema.String, Schema.NonEmptyString))
})

export const SettingsFile = Schema.Struct({
  /** Path of the OpenRouter key (absolute, or relative to the home dir). The key itself never goes in config. */
  openRouterKeyFile: Schema.optionalKey(Schema.NonEmptyString),
  components: Schema.optionalKey(Schema.Record(Schema.String, ComponentSettings))
})
export type SettingsFile = typeof SettingsFile.Type

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(SettingsFile), { onExcessProperty: "error" })
const decodeValue = Schema.decodeUnknownEffect(SettingsFile, { onExcessProperty: "error" })

/** Runtime events (`atomic-agents/<name>`), validated like any component's. */
export const RUNTIME = "atomic-agents"
const Source = Schema.Literals(["use", "set", "file"])
const Change = Schema.Struct({
  path: Schema.Array(Schema.String),
  /** `null` when the key was absent. */
  old: Schema.Json,
  new: Schema.Json
})
export type Change = typeof Change.Type
const Patch = Schema.Record(Schema.String, Schema.Json)

export const events = {
  /** Request: apply `patch` (JSON merge patch, RFC 7396: `null` removes a key) to config.json. The service applies it. */
  "config.set": Schema.Struct({ by: Schema.NonEmptyString, patch: Patch }),
  /** `undo` is the merge patch that restores the old values: emit it back as `config.set` to revert. */
  "config.changed": Schema.Struct({ by: Schema.String, source: Source, changes: Schema.Array(Change), undo: Patch, config: SettingsFile }),
  /** A bad edit or request; the last good config stays in force. */
  "config.rejected": Schema.Struct({ by: Schema.String, source: Source, error: Schema.String })
}

export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
  message: Schema.String
}) {}

/** A component with config.json applied. */
export interface Effective {
  readonly enabled: boolean
  readonly agent: Agent
  /** The cron expression for a job's Cron trigger: config override, else the code's. */
  cron(job: string, fallback: string): string
}

export const effective = (component: Registered, settings: SettingsFile): Effective => {
  const own = settings.components?.[component.id] ?? {}
  const thinking = own.thinking ?? component.agent.thinking
  return {
    enabled: own.enabled ?? true,
    agent: {
      system: component.agent.system,
      model: own.model ?? component.agent.model,
      candidates: own.candidates ?? component.agent.candidates,
      ...(thinking === undefined ? {} : { thinking })
    },
    cron: (job, fallback) => own.cron?.[job] ?? fallback
  }
}

/** What the schema cannot know: component and job ids exist, and crons parse. */
const check = (settings: SettingsFile, components: ReadonlyArray<Registered>): ReadonlyArray<string> =>
  Object.entries(settings.components ?? {}).flatMap(([id, own]) => {
    const component = components.find((candidate) => candidate.id === id)
    if (component === undefined) return [`unknown component ${id} (have: ${components.map((c) => c.id).join(", ")})`]
    return Object.entries(own.cron ?? {}).flatMap(([jobId, cron]) => {
      const job = component.jobs.find((candidate) => candidate.id === jobId)
      if (job === undefined || !job.triggers.some((trigger) => trigger._tag === "Cron")) return [`${id} has no cron job ${jobId}`]
      return Result.isFailure(Cron.parse(cron)) ? [`${id}.cron.${jobId}: bad cron "${cron}"`] : []
    })
  })

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** RFC 7396 JSON merge patch. */
export const mergePatch = (target: unknown, patch: unknown): unknown => {
  if (!isObject(patch)) return patch
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else out[key] = mergePatch(out[key], value)
  }
  return out
}

/** Leaf values by path; arrays are leaves (a merge patch replaces them whole). */
const leaves = (value: unknown, prefix: ReadonlyArray<string> = [], out = new Map<string, { path: ReadonlyArray<string>; value: unknown }>()) => {
  if (isObject(value)) for (const [key, child] of Object.entries(value)) leaves(child, [...prefix, key], out)
  else out.set(JSON.stringify(prefix), { path: prefix, value })
  return out
}

export const diff = (before: SettingsFile, after: SettingsFile): ReadonlyArray<Change> => {
  const [old, next] = [leaves(before), leaves(after)]
  return [...new Set([...old.keys(), ...next.keys()])].flatMap((key) => {
    const [a, b] = [old.get(key), next.get(key)]
    if (JSON.stringify(a?.value) === JSON.stringify(b?.value)) return []
    return [{ path: (a ?? b)!.path, old: (a?.value ?? null) as Schema.Json, new: (b?.value ?? null) as Schema.Json }]
  })
}

const undoPatch = (changes: ReadonlyArray<Change>) => {
  const patch: Record<string, Schema.Json> = {}
  for (const change of changes) {
    let node: Record<string, Schema.Json> = patch
    change.path.forEach((key, index) => {
      if (index === change.path.length - 1) node[key] = change.old
      else node = (node[key] ??= {}) as Record<string, Schema.Json>
    })
  }
  return patch
}

export class Settings extends Context.Service<Settings, {
  readonly file: string
  /** The config in force; live in the service, read once at start elsewhere. */
  readonly current: Effect.Effect<SettingsFile>
  readonly changes: Stream.Stream<SettingsFile>
  /** Merge-patch config.json: validate, publish config.changed, then swap the file in. A bad patch publishes config.rejected and fails. */
  set(patch: Record<string, Schema.Json>, by: string, source: "use" | "set"): Effect.Effect<ReadonlyArray<Change>, SettingsError | JournalError>
  /** Service only: watch config.json and apply `config.set` requests; runs until interrupted. */
  readonly serve: Effect.Effect<never>
}>()("atomic-agents/Settings") {
  static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const bus = yield* EventBus
      const components = yield* Components
      const file = path.join((yield* Home).root, "config.json")
      const lock = yield* Semaphore.make(1)

      const read = fs.exists(file).pipe(
        Effect.flatMap((exists) => exists ? fs.readFileString(file) : Effect.succeed("")),
        Effect.mapError((error) => new SettingsError({ message: `read ${file}: ${error.message}` }))
      )
      const validate = (settings: SettingsFile) => {
        const errors = check(settings, components)
        return errors.length === 0 ? Effect.succeed(settings) : Effect.fail(new SettingsError({ message: errors.join("; ") }))
      }
      const parse = (text: string) =>
        text.trim() === ""
          ? Effect.succeed<SettingsFile>({})
          : decodeFile(text).pipe(Effect.mapError((error) => new SettingsError({ message: error.message })), Effect.flatMap(validate))

      const publish = <K extends keyof typeof events>(name: K, data: (typeof events)[K]["Type"]) =>
        Schema.encodeUnknownEffect(events[name])(data).pipe(
          Effect.orDie,
          Effect.flatMap((encoded) =>
            makeEvent({ type: `${RUNTIME}/${name}`, component: RUNTIME, job: "config", run: `config-${crypto.randomUUID().slice(0, 8)}`, data: encoded })),
          Effect.flatMap(bus.publish)
        )

      const initial = yield* read.pipe(Effect.flatMap(parse), Effect.catch((error) =>
        Effect.logWarning(`config.json rejected, using code defaults: ${error.message}`).pipe(Effect.as<SettingsFile>({}))))
      const ref = yield* SubscriptionRef.make(initial)

      const set = Effect.fn("Settings.set")(function*(patch: Record<string, Schema.Json>, by: string, source: "use" | "set") {
        const reject = (message: string) =>
          publish("config.rejected", { by, source, error: message }).pipe(Effect.andThen(Effect.fail(new SettingsError({ message }))))
        const before = yield* read.pipe(Effect.flatMap(parse), Effect.catchTag("SettingsError", (error) => reject(`config.json is invalid, fix it first: ${error.message}`)))
        const after = yield* decodeValue(mergePatch(before, patch)).pipe(
          Effect.mapError((error) => new SettingsError({ message: error.message })),
          Effect.flatMap(validate),
          Effect.catchTag("SettingsError", (error) => reject(error.message))
        )
        const changes = diff(before, after)
        if (changes.length === 0) return changes
        const temp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`
        yield* fs.writeFileString(temp, `${JSON.stringify(after, null, 2)}\n`).pipe(Effect.orDie)
        // Announce before the rename: a watching service then finds this event and does not report the edit again.
        yield* publish("config.changed", { by, source, changes, undo: undoPatch(changes), config: after })
        yield* fs.rename(temp, file).pipe(Effect.orDie)
        yield* SubscriptionRef.set(ref, after)
        return changes
      }, lock.withPermits(1))

      /** Poll config.json: a valid edit swaps in (config.changed unless a writer announced it), a bad one keeps the last good config (config.rejected). */
      let seen: string | undefined
      const poll = Effect.gen(function*() {
        const text = yield* read
        if (text === seen) return
        seen = text
        const parsed = yield* Effect.result(parse(text))
        if (Result.isFailure(parsed)) return yield* publish("config.rejected", { by: "file", source: "file", error: parsed.failure.message })
        const changes = diff(yield* SubscriptionRef.get(ref), parsed.success)
        if (changes.length === 0) return
        yield* SubscriptionRef.set(ref, parsed.success)
        const announced = (yield* bus.history).filter((event) => event.type === `${RUNTIME}/config.changed`).at(-1)
        const config = Schema.decodeUnknownOption(events["config.changed"])(announced?.data)
        if (config._tag === "Some" && diff(config.value.config, parsed.success).length === 0) return
        yield* publish("config.changed", { by: "file", source: "file", changes, undo: undoPatch(changes), config: parsed.success })
      }).pipe(lock.withPermits(1))

      const serve = Effect.gen(function*() {
        const request = Schema.decodeUnknownEffect(events["config.set"])
        yield* bus.subscribe.pipe(
          Stream.filter((event) => event.type === `${RUNTIME}/config.set`),
          Stream.runForEach((event) =>
            request(event.data).pipe(
              Effect.flatMap(({ by, patch }) => set(patch, by, "set")),
              Effect.catch((error) => Effect.logWarning("config.set", error))
            )),
          Effect.forkScoped
        )
        yield* poll.pipe(
          Effect.catch((error) => Effect.logWarning("config watch", error)),
          Effect.repeat(Schedule.spaced("1 second")),
          Effect.forkScoped
        )
        return yield* Effect.never
      }).pipe(Effect.scoped)

      return Settings.of({ file, current: SubscriptionRef.get(ref), changes: SubscriptionRef.changes(ref), set, serve })
    })
  )
}
