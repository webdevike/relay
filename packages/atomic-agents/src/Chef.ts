import { Config, Context, Effect, Exit, FiberSet, FileSystem, Layer, Option, Path, Ref, Schedule, Schema, Scope, Semaphore, Stream, SubscriptionRef } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { Adapters } from "./Adapter.ts"
import { Background } from "./Background.ts"
import type { Job, Registered } from "./Component.ts"
import { EventBus, Home, type JournalError } from "./Event.ts"
import { compileRecipe, type Cook, RecipeFile } from "./Recipe.ts"
import { publishRuntime } from "./RuntimeEvents.ts"

/**
 * Chefs: the components a process runs. The default way to make one is a file, `chefs/<id>.json` (or
 * `.yaml`): a recipe (`Recipe.ts`) assembled from adapters. `kind: "code"` is the escape hatch: the file
 * points at a module whose export is a `define()`d component. Files load from the package's own
 * `chefs/` (the built-ins) and then `<home>/chefs/`, where a file replaces a built-in of the same id.
 * The service re-reads both every second: a valid edit swaps in (`chef.loaded`), a bad one keeps the last
 * good version (`config.rejected`), a deleted file removes its chef (`chef.removed`).
 */
export const BUILTIN_CHEFS = new URL("../chefs", import.meta.url).pathname

export const CodeFile = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("code"),
  /** The module, relative to this file. */
  module: Schema.NonEmptyString,
  /** Its export holding the `define()`d component (default `default`). */
  export: Schema.optionalKey(Schema.NonEmptyString)
})

/** A component as this process runs it. */
export interface Chef extends Registered {
  readonly kind: "recipe" | "code"
  /** The chef file, or undefined for one the host passed in as code. */
  readonly file: string | undefined
  /** Its jobs with their tools built (in the chef's own scope, closed when it is replaced or removed). */
  readonly runnable: ReadonlyArray<Job<BunServices>>
  /** A recipe's model stage, for benches that call it without the bus. */
  readonly cook: Cook | undefined
}

export class ChefError extends Schema.TaggedError<ChefError>()("ChefError", {
  file: Schema.String,
  message: Schema.String
}) {}

const ID = /^[a-z][a-z0-9-]*$/
const EXTENSIONS = /\.(json|ya?ml)$/

const decodeRecipe = Schema.decodeUnknownEffect(RecipeFile, { onExcessProperty: "error" })
const decodeCode = Schema.decodeUnknownEffect(CodeFile, { onExcessProperty: "error" })

const isRegistered = (value: unknown): value is Registered =>
  typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && "jobs" in value && Array.isArray(value.jobs) &&
  "build" in value && Effect.isEffect(value.build)

/** `~/x` and `${VAR}` / `${VAR:-default}` expand (from Config, so tests can set them); a relative path is relative to `dir`. */
export const expandPath = Effect.fnUntraced(function*(raw: string, dir: string) {
  const path = yield* Path.Path
  let missing: string | undefined
  let out = raw
  for (const match of raw.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g)) {
    const value = yield* Config.option(Config.String(match[1]!))
    const resolved = Option.getOrElse(value, () => match[2])
    if (resolved === undefined) missing ??= match[1]
    out = out.replace(match[0], resolved ?? "")
  }
  if (missing !== undefined) return { ok: false as const, error: `\${${missing}} is not set and has no default` }
  if (out.startsWith("~/")) out = path.join(yield* Config.String("HOME"), out.slice(2))
  return { ok: true as const, path: path.resolve(dir, out) }
})

/**
 * Read, decode and compile one chef file; nothing is built. Every reason it cannot load is in the
 * `ChefError`'s message, prefixed with the file, so `config.rejected` and `chef validate` say what to fix.
 */
export const parseChef = Effect.fn("Chef.parse")(function*(file: string, text: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const adapters = yield* Adapters
  const fail = (message: string) => Effect.fail(new ChefError({ file, message: `${file}: ${message}` }))
  const raw = yield* Effect.try({
    try: (): unknown => file.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text),
    catch: (error) => new ChefError({ file, message: `${file}: not valid ${file.endsWith(".json") ? "JSON" : "YAML"}: ${String(error)}` })
  })
  const stem = path.basename(file).replace(EXTENSIONS, "")
  const object = typeof raw === "object" && raw !== null ? raw : {}
  const kind = "kind" in object ? object.kind : "recipe"
  const id = "id" in object ? object.id : undefined
  if (typeof id !== "string" || !ID.test(id)) return yield* fail(`id must be kebab-case (got ${JSON.stringify(id)})`)
  if (id !== stem) return yield* fail(`id ${id} must match the file name (${stem})`)
  const dir = path.dirname(file)

  if (kind === "code") {
    const spec = yield* decodeCode(raw).pipe(Effect.catchTag("SchemaError", (error) => fail(error.message)))
    const target = yield* expandPath(spec.module, dir)
    if (!target.ok) return yield* fail(`module: ${target.error}`)
    if (!(yield* fs.exists(target.path).pipe(Effect.orElseSucceed(() => false)))) return yield* fail(`module ${target.path} does not exist`)
    // The file's text in the URL: an edited module is imported afresh, not served from the module cache.
    const version = Bun.hash(yield* fs.readFileString(target.path).pipe(Effect.orElseSucceed(() => ""))).toString(36)
    const module = yield* Effect.tryPromise({
      try: () => import(`${target.path}?v=${version}`) as Promise<Record<string, unknown>>,
      catch: (error) => new ChefError({ file, message: `${file}: import ${target.path}: ${String(error)}` })
    })
    const name = spec.export ?? "default"
    const chef = module[name]
    if (!isRegistered(chef)) return yield* fail(`${target.path} exports no define()d component as ${name} (exports: ${Object.keys(module).join(", ") || "none"})`)
    if (chef.id !== id) return yield* fail(`${target.path} ${name} has id ${chef.id}, not ${id}`)
    return { chef, kind: "code" as const, cook: undefined }
  }
  if (kind !== "recipe") return yield* fail(`kind must be "recipe" (the default) or "code" (got ${JSON.stringify(kind)})`)

  const spec = yield* decodeRecipe(raw).pipe(Effect.catchTag("SchemaError", (error) => fail(error.message)))
  const errors: Array<string> = []
  const knowledge: Array<{ file: string; heading?: string }> = []
  for (const [index, entry] of (spec.agent.knowledge ?? []).entries()) {
    const target = yield* expandPath(entry.file, dir)
    if (!target.ok) errors.push(`agent.knowledge[${index}]: ${target.error}`)
    else if (!(yield* fs.exists(target.path).pipe(Effect.orElseSucceed(() => false)))) errors.push(`agent.knowledge[${index}]: ${target.path} does not exist`)
    else knowledge.push({ file: target.path, ...(entry.heading === undefined ? {} : { heading: entry.heading }) })
  }
  const compiled = compileRecipe(spec, {
    adapters,
    knowledge,
    readFile: (target) => fs.readFileString(target).pipe(Effect.mapError((error) => new ChefError({ file, message: `knowledge ${target}: ${error.message}` })))
  })
  if (compiled._tag === "Failure" || errors.length > 0) {
    return yield* fail([...errors, ...(compiled._tag === "Failure" ? compiled.failure : [])].join("; "))
  }
  return { chef: compiled.success.chef, kind: "recipe" as const, cook: compiled.success.cook }
})

/** One chef file as the loader last saw it: its text, and the last version that loaded. */
interface Entry {
  readonly text: string
  readonly chef: Chef | undefined
  readonly scope: Scope.Closeable | undefined
}

export interface ChefsOptions {
  /** Directories scanned in order (later ones replace earlier ones' ids); default: the built-ins, then `<home>/chefs`. */
  readonly dirs?: (home: string) => ReadonlyArray<string>
  /** Components the host passes in as code (tests); a file cannot reuse their ids. */
  readonly code?: ReadonlyArray<Registered>
}

export class Chefs extends Context.Service<Chefs, {
  readonly dirs: ReadonlyArray<string>
  /** The chefs in force. */
  readonly current: Effect.Effect<ReadonlyArray<Chef>>
  readonly changes: Stream.Stream<ReadonlyArray<Chef>>
  /** Re-read every chef file once and swap in what changed, announcing it on the bus. */
  readonly reload: Effect.Effect<void, JournalError>
}>()("atomic-agents/Chefs") {
  static readonly make = (options: ChefsOptions = {}) =>
    Layer.effect(
      Chefs,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* Home
        const bus = yield* EventBus
        const services = yield* Effect.context<BunServices | Adapters>()
        const dirs = options.dirs?.(home.root) ?? [BUILTIN_CHEFS, path.join(home.root, "chefs")]
        const lock = yield* Semaphore.make(1)

        const code = yield* Effect.forEach(options.code ?? [], (component) =>
          Effect.map(component.build, (runnable): Chef => ({ ...component, kind: "code", file: undefined, runnable, cook: undefined })))
        const entries = yield* Ref.make<ReadonlyMap<string, Entry>>(new Map())
        // Every scope still open closes with the layer.
        yield* Effect.addFinalizer(() =>
          Effect.flatMap(Ref.get(entries), (all) => Effect.forEach([...all.values()], (entry) => entry.scope ? Scope.close(entry.scope, Exit.void) : Effect.void, { discard: true })))

        const build = (file: string, text: string) =>
          Effect.gen(function*() {
            const parsed = yield* parseChef(file, text)
            const scope = yield* Scope.make()
            const runnable = yield* parsed.chef.build.pipe(
              Scope.provide(scope),
              Effect.tapError(() => Scope.close(scope, Exit.void)),
              Effect.mapError((error) => new ChefError({ file, message: `${file}: build tools: ${error.message}` }))
            )
            return { chef: { ...parsed.chef, kind: parsed.kind, file, runnable, cook: parsed.cook } satisfies Chef, scope }
          }).pipe(Effect.provideContext(services))

        const files = Effect.forEach(dirs, (dir) =>
          fs.readDirectory(dir).pipe(
            Effect.map((names) => names.filter((name) => EXTENSIONS.test(name)).sort().map((name) => path.join(dir, name))),
            Effect.orElseSucceed((): ReadonlyArray<string> => [])
          )).pipe(Effect.map((lists) => lists.flat()))

        /** One pass over the chef dirs; `announce` publishes what changed (the service), else it only logs (one-shot commands). */
        const scan = (announce: boolean) =>
          Effect.gen(function*() {
            const say = <K extends "chef.loaded" | "chef.removed" | "config.rejected">(name: K, data: Parameters<typeof publishRuntime<K>>[2]) =>
              announce ? publishRuntime(bus, name, data, "chefs") : Effect.void
            const before = yield* Ref.get(entries)
            const after = new Map<string, Entry>()
            for (const file of yield* files) {
              const text = yield* fs.readFileString(file).pipe(Effect.option)
              const previous = before.get(file)
              if (Option.isNone(text)) {
                if (previous) after.set(file, previous)
                continue
              }
              if (previous?.text === text.value) {
                after.set(file, previous)
                continue
              }
              const built = yield* Effect.result(build(file, text.value))
              if (built._tag === "Failure") {
                after.set(file, { text: text.value, chef: previous?.chef, scope: previous?.scope })
                yield* Effect.logWarning(`chef rejected${previous?.chef ? ", keeping the last good version" : ""}: ${built.failure.message}`)
                yield* say("config.rejected", { by: "file", source: "file", error: built.failure.message })
                continue
              }
              if (previous?.scope) yield* Scope.close(previous.scope, Exit.void)
              after.set(file, { text: text.value, chef: built.success.chef, scope: built.success.scope })
              yield* say("chef.loaded", { id: built.success.chef.id, file, kind: built.success.chef.kind, replaced: previous?.chef !== undefined })
            }
            for (const [file, entry] of before) {
              if (after.has(file)) continue
              if (entry.scope) yield* Scope.close(entry.scope, Exit.void)
              if (entry.chef) yield* say("chef.removed", { id: entry.chef.id, file })
            }
            yield* Ref.set(entries, after)

            // Later dirs replace earlier ones' ids; within one dir, or against code, an id is taken once.
            const byId = new Map<string, Chef>(code.map((chef) => [chef.id, chef]))
            for (const entry of after.values()) {
              const chef = entry.chef
              if (chef === undefined) continue
              const taken = byId.get(chef.id)
              if (taken !== undefined && (taken.file === undefined || path.dirname(taken.file) === path.dirname(chef.file!))) {
                yield* Effect.logWarning(`${chef.file}: id ${chef.id} is already taken by ${taken.file ?? "a code component"}; ignored`)
                continue
              }
              byId.set(chef.id, chef)
            }
            const next = [...byId.values()]
            const current = yield* SubscriptionRef.get(ref)
            if (next.length !== current.length || next.some((chef, index) => chef !== current[index])) yield* SubscriptionRef.set(ref, next)
          }).pipe(lock.withPermits(1))

        const ref = yield* SubscriptionRef.make<ReadonlyArray<Chef>>(code)
        yield* scan(false)
        return Chefs.of({ dirs, current: SubscriptionRef.get(ref), changes: SubscriptionRef.changes(ref), reload: scan(true) })
      })
    )

  static readonly layer = Chefs.make()

  /** Background layer: re-read the chef files every second. */
  static readonly layerWatch = Layer.effectDiscard(Effect.gen(function*() {
    const chefs = yield* Chefs
    yield* FiberSet.run(yield* Background, chefs.reload.pipe(Effect.repeat(Schedule.spaced("1 second"))))
  }))
}
