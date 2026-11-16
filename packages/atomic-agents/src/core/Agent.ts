import { Config, Context, Effect, Exit, FiberSet, FileSystem, Layer, Option, Path, Ref, Schedule, Schema, Scope, Semaphore, Stream, SubscriptionRef } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { Adapters } from "./Adapter.ts"
import { Background } from "./Background.ts"
import type { Job, Registered } from "./Component.ts"
import { EventBus, Home, type JournalError } from "./Event.ts"
import { compileAgentSpec, type ModelStage, AgentSpec } from "./AgentSpec.ts"
import { publishRuntime } from "./RuntimeEvents.ts"

/**
 * Agents: the components a process runs. The default way to make one is a file, `<id>.json` (or
 * `.yaml`): an agent spec (`AgentSpec.ts`) assembled from adapters. `kind: "code"` is the escape hatch: the file
 * points at a module whose export is a `define()`d component. Files load from the package's domains
 * (`domains/<domain>/`, the built-ins) and then `<home>/agents/`, where a file replaces a built-in of the same id.
 * The service re-reads both every second: a valid edit swaps in (`agent.loaded`), a bad one keeps the last
 * good version (`config.rejected`), a deleted file removes its agent (`agent.removed`).
 */
const DOMAINS = new URL("../../domains", import.meta.url).pathname

/** The built-in agent dirs: one per domain, `domains/<domain>/`, in name order. */
export const BUILTIN_AGENTS: ReadonlyArray<string> = readdirSync(DOMAINS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(DOMAINS, entry.name))
  .sort()

export const CodeFile = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("code"),
  /** The module, relative to this file. */
  module: Schema.NonEmptyString,
  /** Its export holding the `define()`d component (default `default`). */
  export: Schema.optionalKey(Schema.NonEmptyString)
})

/** A component as this process runs it. */
export interface Agent extends Registered {
  readonly kind: "spec" | "code"
  /** The agent file, or undefined for one the host passed in as code. */
  readonly file: string | undefined
  /** Its jobs with their tools built (in the agent's own scope, closed when it is replaced or removed). */
  readonly runnable: ReadonlyArray<Job<BunServices>>
  /** An agent spec's model stage, for benches that call it without the bus. */
  readonly modelStage: ModelStage | undefined
}

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  file: Schema.String,
  message: Schema.String
}) {}

const ID = /^[a-z][a-z0-9-]*$/
const EXTENSIONS = /\.(json|ya?ml)$/

const decodeAgentSpec = Schema.decodeUnknownEffect(AgentSpec, { onExcessProperty: "error" })
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
 * Read, decode and compile one agent file; nothing is built. Every reason it cannot load is in the
 * `AgentError`'s message, prefixed with the file, so `config.rejected` and `agent validate` say what to fix.
 */
export const parseAgent = Effect.fn("Agent.parse")(function*(file: string, text: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const adapters = yield* Adapters
  const fail = (message: string) => Effect.fail(new AgentError({ file, message: `${file}: ${message}` }))
  const raw = yield* Effect.try({
    try: (): unknown => file.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text),
    catch: (error) => new AgentError({ file, message: `${file}: not valid ${file.endsWith(".json") ? "JSON" : "YAML"}: ${String(error)}` })
  })
  const stem = path.basename(file).replace(EXTENSIONS, "")
  const object = typeof raw === "object" && raw !== null ? raw : {}
  const kind = "kind" in object ? object.kind : "spec"
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
      catch: (error) => new AgentError({ file, message: `${file}: import ${target.path}: ${String(error)}` })
    })
    const name = spec.export ?? "default"
    const agent = module[name]
    if (!isRegistered(agent)) return yield* fail(`${target.path} exports no define()d component as ${name} (exports: ${Object.keys(module).join(", ") || "none"})`)
    if (agent.id !== id) return yield* fail(`${target.path} ${name} has id ${agent.id}, not ${id}`)
    return { agent, kind: "code" as const, modelStage: undefined }
  }
  if (kind !== "spec") return yield* fail(`kind must be "spec" (the default) or "code" (got ${JSON.stringify(kind)})`)

  const spec = yield* decodeAgentSpec(raw).pipe(Effect.catchTag("SchemaError", (error) => fail(error.message)))
  const errors: Array<string> = []
  const knowledge: Array<{ file: string; heading?: string }> = []
  for (const [index, entry] of (spec.agent.knowledge ?? []).entries()) {
    const target = yield* expandPath(entry.file, dir)
    if (!target.ok) errors.push(`agent.knowledge[${index}]: ${target.error}`)
    else if (!(yield* fs.exists(target.path).pipe(Effect.orElseSucceed(() => false)))) errors.push(`agent.knowledge[${index}]: ${target.path} does not exist`)
    else knowledge.push({ file: target.path, ...(entry.heading === undefined ? {} : { heading: entry.heading }) })
  }
  const compiled = compileAgentSpec(spec, {
    adapters,
    knowledge,
    readFile: (target) => fs.readFileString(target).pipe(Effect.mapError((error) => new AgentError({ file, message: `knowledge ${target}: ${error.message}` })))
  })
  if (compiled._tag === "Failure" || errors.length > 0) {
    return yield* fail([...errors, ...(compiled._tag === "Failure" ? compiled.failure : [])].join("; "))
  }
  return { agent: compiled.success.agent, kind: "spec" as const, modelStage: compiled.success.modelStage }
})

/** One agent file as the loader last saw it: its text, and the last version that loaded. */
interface Entry {
  readonly text: string
  readonly agent: Agent | undefined
  readonly scope: Scope.Closeable | undefined
}

export interface AgentsOptions {
  /** Directories scanned in order (later ones replace earlier ones' ids); default: the built-ins, then `<home>/agents`. */
  readonly dirs?: (home: string) => ReadonlyArray<string>
  /** Components the host passes in as code (tests); a file cannot reuse their ids. */
  readonly code?: ReadonlyArray<Registered>
}

export class Agents extends Context.Service<Agents, {
  readonly dirs: ReadonlyArray<string>
  /** The agents in force. */
  readonly current: Effect.Effect<ReadonlyArray<Agent>>
  readonly changes: Stream.Stream<ReadonlyArray<Agent>>
  /** Re-read every agent file once and swap in what changed, announcing it on the bus. */
  readonly reload: Effect.Effect<void, JournalError>
}>()("atomic-agents/Agents") {
  static readonly make = (options: AgentsOptions = {}) =>
    Layer.effect(
      Agents,
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* Home
        const bus = yield* EventBus
        const services = yield* Effect.context<BunServices | Adapters>()
        const dirs = options.dirs?.(home.root) ?? [...BUILTIN_AGENTS, path.join(home.root, "agents")]
        const lock = yield* Semaphore.make(1)

        const code = yield* Effect.forEach(options.code ?? [], (component) =>
          Effect.map(component.build, (runnable): Agent => ({ ...component, kind: "code", file: undefined, runnable, modelStage: undefined })))
        const entries = yield* Ref.make<ReadonlyMap<string, Entry>>(new Map())
        // Every scope still open closes with the layer.
        yield* Effect.addFinalizer(() =>
          Effect.flatMap(Ref.get(entries), (all) => Effect.forEach([...all.values()], (entry) => entry.scope ? Scope.close(entry.scope, Exit.void) : Effect.void, { discard: true })))

        const build = (file: string, text: string) =>
          Effect.gen(function*() {
            const parsed = yield* parseAgent(file, text)
            const scope = yield* Scope.make()
            const runnable = yield* parsed.agent.build.pipe(
              Scope.provide(scope),
              Effect.tapError(() => Scope.close(scope, Exit.void)),
              Effect.mapError((error) => new AgentError({ file, message: `${file}: build tools: ${error.message}` }))
            )
            return { agent: { ...parsed.agent, kind: parsed.kind, file, runnable, modelStage: parsed.modelStage } satisfies Agent, scope }
          }).pipe(Effect.provideContext(services))

        const files = Effect.forEach(dirs, (dir) =>
          fs.readDirectory(dir).pipe(
            Effect.map((names) => names.filter((name) => EXTENSIONS.test(name)).sort().map((name) => path.join(dir, name))),
            Effect.orElseSucceed((): ReadonlyArray<string> => [])
          )).pipe(Effect.map((lists) => lists.flat()))

        /** One pass over the agent dirs; `announce` publishes what changed (the service), else it only logs (one-shot commands). */
        const scan = (announce: boolean) =>
          Effect.gen(function*() {
            const say = <K extends "agent.loaded" | "agent.removed" | "config.rejected">(name: K, data: Parameters<typeof publishRuntime<K>>[2]) =>
              announce ? publishRuntime(bus, name, data, "agents") : Effect.void
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
                after.set(file, { text: text.value, agent: previous?.agent, scope: previous?.scope })
                yield* Effect.logWarning(`agent rejected${previous?.agent ? ", keeping the last good version" : ""}: ${built.failure.message}`)
                yield* say("config.rejected", { by: "file", source: "file", error: built.failure.message })
                continue
              }
              if (previous?.scope) yield* Scope.close(previous.scope, Exit.void)
              after.set(file, { text: text.value, agent: built.success.agent, scope: built.success.scope })
              yield* say("agent.loaded", { id: built.success.agent.id, file, kind: built.success.agent.kind, replaced: previous?.agent !== undefined })
            }
            for (const [file, entry] of before) {
              if (after.has(file)) continue
              if (entry.scope) yield* Scope.close(entry.scope, Exit.void)
              if (entry.agent) yield* say("agent.removed", { id: entry.agent.id, file })
            }
            yield* Ref.set(entries, after)

            // Later dirs replace earlier ones' ids; within one dir, or against code, an id is taken once.
            const byId = new Map<string, Agent>(code.map((agent) => [agent.id, agent]))
            for (const entry of after.values()) {
              const agent = entry.agent
              if (agent === undefined) continue
              const taken = byId.get(agent.id)
              if (taken !== undefined && (taken.file === undefined || path.dirname(taken.file) === path.dirname(agent.file!))) {
                yield* Effect.logWarning(`${agent.file}: id ${agent.id} is already taken by ${taken.file ?? "a code component"}; ignored`)
                continue
              }
              byId.set(agent.id, agent)
            }
            const next = [...byId.values()]
            const current = yield* SubscriptionRef.get(ref)
            if (next.length !== current.length || next.some((agent, index) => agent !== current[index])) yield* SubscriptionRef.set(ref, next)
          }).pipe(lock.withPermits(1))

        const ref = yield* SubscriptionRef.make<ReadonlyArray<Agent>>(code)
        yield* scan(false)
        return Agents.of({ dirs, current: SubscriptionRef.get(ref), changes: SubscriptionRef.changes(ref), reload: scan(true) })
      })
    )

  static readonly layer = Agents.make()

  /** Background layer: re-read the agent files every second. */
  static readonly layerWatch = Layer.effectDiscard(Effect.gen(function*() {
    const agents = yield* Agents
    yield* FiberSet.run(yield* Background, agents.reload.pipe(Effect.repeat(Schedule.spaced("1 second"))))
  }))
}
