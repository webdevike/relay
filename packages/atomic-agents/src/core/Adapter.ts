import { Context, Effect, Layer, type Schema, type Scope } from "effect"
import { type Fields, fromStruct } from "./Fields.ts"
import type { BunServices } from "@effect/platform-bun/BunServices"
import type { Failure, RunContext, ToolsError } from "./Component.ts"
import type { GenerateRequest, Generation, ModelError, ModelRunner } from "./Model.ts"

/**
 * Adapters: the small, named parts a config agent is assembled from (`Agent.ts`, `AgentSpec.ts`). An agent file
 * names them by id; an id no adapter has is a load error (`config.rejected`), never a run failure. Adapters
 * come in packs that share one layer of services (the gmail pack's IMAP wrapper, the blender pack's binary);
 * every pack's layer is built once per process, so swapping an adapter never touches an agent.
 *
 * Every effect may use the platform services (`BunServices`); the runtime provides them per run.
 */

/** What a run hands an adapter: the run's ids, dirs, model and agent; no `publish` (only the agent spec emits). */
export type AdapterContext = Omit<RunContext, "publish">

/** One model call. `omp` today; a direct API adapter later. `ModelRunner` is the process's omp runner (or a test fake). */
export interface ModelAdapter<R = never> {
  readonly name: string
  readonly description: string
  generate(request: GenerateRequest): Effect.Effect<Generation, ModelError, R | ModelRunner | BunServices>
}

/** Who called a tool: the model in the tool loop, or a script the model wrote (tool mode `code`, `CodeMode.ts`). */
export type Caller = "model" | "script"

/**
 * A tool the model may call in the agent spec's tool loop; the model sees the part after the last dot (`gmail.read_thread` → `read_thread`).
 * `fields` is the item the model is working on (input, source and step fields), for what the model should not have to
 * repeat: the repo a review comment is in, the moment a replay reads Linear as of.
 */
export interface ToolAdapter<R = never> {
  readonly name: string
  readonly description: string
  readonly args: Schema.Decoder<unknown>
  /** The args object as the model should write it, e.g. `{"id": "<message id>"}`. */
  readonly example: string
  /**
   * What a script gets back (tool mode `code`): `CodeMode.ts` turns it and `args` into the tool's typed function, so
   * every tool is a typed API without extra work. It describes, it does not check: keep it next to the code that builds the value.
   */
  readonly returns: Schema.Top
  /**
   * The result, JSON-serialisable. Failures go back to the model as text (a script gets them thrown).
   * `caller` lets a tool answer a script more than the model's window (a whole page, not its passages).
   */
  run(args: unknown, fields: Readonly<Record<string, unknown>>, caller: Caller): Effect.Effect<unknown, { readonly message: string }, R | BunServices>
}

/** The name the model calls a tool by: the part after the last dot (`gmail.read_thread` → `read_thread`). */
export const shortName = (name: string) => name.slice(name.lastIndexOf(".") + 1)

/** A tool adapter whose `run` takes its args schema's type; the agent spec decodes the model's args with `args` before it calls `run`. */
export const toolAdapter = <S extends Schema.Decoder<unknown>, R>(spec: {
  readonly name: string
  readonly description: string
  readonly args: S
  readonly example: string
  readonly returns: Schema.Top
  readonly run: (args: S["Type"], fields: Readonly<Record<string, unknown>>, caller: Caller) => Effect.Effect<unknown, { readonly message: string }, R | BunServices>
}): ToolAdapter<R> => ({ ...spec, run: (args, fields, caller) => spec.run(args as S["Type"], fields, caller) })

export interface SourceItem<R = never> {
  /** Fields this item adds to the run input (the adapter's `provides`). */
  readonly fields: Readonly<Record<string, unknown>>
  /** Runs once the item's output event is in the journal (a cursor moving past it). */
  readonly commit: Effect.Effect<void, Failure, R | BunServices>
}

export interface SourceBatch<R = never> {
  readonly items: ReadonlyArray<SourceItem<R>>
  /** Runs after every item is done. */
  readonly done: Effect.Effect<void, Failure, R | BunServices>
  /** Fields for the agent spec's summary event (the adapter's `summary`). */
  readonly summary: Readonly<Record<string, unknown>>
}

/** A fixed fetch before the model: turns the run input into the items the model handles one by one. */
export interface SourceAdapter<R = never> {
  readonly name: string
  readonly description: string
  readonly provides: ReadonlyArray<string>
  readonly summary: ReadonlyArray<string>
  fetch(input: Readonly<Record<string, unknown>>, context: AdapterContext): Effect.Effect<SourceBatch<R>, Failure, R | BunServices>
}

export interface CheckReply {
  readonly text: string
  /** The decoded answer, when the agent spec declares one. */
  readonly answer?: unknown
}

export interface CheckContext extends AdapterContext {
  /** The item's first prompt; a repair prompt builds on it. */
  readonly prompt: string
  /** 1 for the first reply, 2 for the repair. */
  readonly attempt: number
  readonly fields: Readonly<Record<string, unknown>>
}

export type CheckVerdict<R = never> =
  | { readonly pass: true; readonly fields: Readonly<Record<string, unknown>> }
  | {
    readonly pass: false
    /** The prompt for the one repair turn: what failed, in the check's words. */
    readonly repair: string
    /** What the item answers when the repair fails too: fields (answer none), or a failure (the run fails). */
    readonly giveUp: Effect.Effect<Readonly<Record<string, unknown>>, Failure, R | BunServices>
  }

/** The final pass/fail gate on the model's reply, with one repair turn. */
export interface CheckAdapter<R = never> {
  readonly name: string
  readonly description: string
  readonly provides: ReadonlyArray<string>
  /** Text the system prompt can include with `{{check}}`: the contract the check enforces (the parser's signatures). */
  readonly contract?: string
  check(reply: CheckReply, context: CheckContext): Effect.Effect<CheckVerdict<R>, Failure, R | BunServices>
}

/** The escape hatch inside the agent spec: a named code step that adds fields to each item before the model. */
export interface StepAdapter<R = never> {
  readonly name: string
  readonly description: string
  readonly provides: ReadonlyArray<string>
  run(fields: Readonly<Record<string, unknown>>, context: AdapterContext): Effect.Effect<Readonly<Record<string, unknown>>, Failure, R | BunServices>
}

/** Every adapter of every pack, services bound: what agent files are checked and run against. */
export interface Registry {
  readonly models: ReadonlyMap<string, ModelAdapter>
  readonly tools: ReadonlyMap<string, ToolAdapter>
  readonly sources: ReadonlyMap<string, SourceAdapter>
  readonly checks: ReadonlyMap<string, CheckAdapter>
  readonly steps: ReadonlyMap<string, StepAdapter>
  /** Event and answer schemas typed in code (`Schema.Struct`), by the name an agent file refers to them by (`diagram.requested`). */
  readonly schemas: ReadonlyMap<string, Fields>
}

export type AdapterKind = keyof Registry

export interface PackSpec<R> {
  readonly name: string
  readonly layer: Layer.Layer<R, ToolsError, BunServices>
  readonly models?: ReadonlyArray<ModelAdapter<R>>
  readonly tools?: ReadonlyArray<ToolAdapter<R>>
  readonly sources?: ReadonlyArray<SourceAdapter<R>>
  readonly checks?: ReadonlyArray<CheckAdapter<R>>
  readonly steps?: ReadonlyArray<StepAdapter<R>>
  readonly schemas?: Readonly<Record<string, Schema.Struct<Schema.Struct.Fields>>>
}

/** A pack with its services hidden, as `define` hides a component's tools. */
export interface Pack {
  readonly name: string
  readonly build: Effect.Effect<Registry, ToolsError, BunServices | Scope.Scope>
}

export const pack = <R>(spec: PackSpec<R>): Pack => ({
  name: spec.name,
  build: Effect.gen(function*() {
    const context = yield* Layer.build(spec.layer)
    const bind = <A, E, X>(effect: Effect.Effect<A, E, X>) => Effect.provideContext(effect, context)
    const byName = <A extends { readonly name: string }>(list: ReadonlyArray<A> | undefined) => new Map((list ?? []).map((item) => [item.name, item] as const))
    return {
      models: byName((spec.models ?? []).map((model): ModelAdapter => ({ ...model, generate: (request) => bind(model.generate(request)) }))),
      tools: byName((spec.tools ?? []).map((tool): ToolAdapter => ({ ...tool, run: (args, fields, caller) => bind(tool.run(args, fields, caller)) }))),
      sources: byName((spec.sources ?? []).map((source): SourceAdapter => ({
        ...source,
        fetch: (input, run) =>
          bind(source.fetch(input, run)).pipe(Effect.map((batch) => ({
            summary: batch.summary,
            done: bind(batch.done),
            items: batch.items.map((item) => ({ fields: item.fields, commit: bind(item.commit) }))
          })))
      }))),
      checks: byName((spec.checks ?? []).map((check): CheckAdapter => ({
        ...check,
        check: (reply, run) =>
          bind(check.check(reply, run)).pipe(Effect.map((verdict) => verdict.pass ? verdict : { ...verdict, giveUp: bind(verdict.giveUp) }))
      }))),
      steps: byName((spec.steps ?? []).map((step): StepAdapter => ({ ...step, run: (fields, run) => bind(step.run(fields, run)) }))),
      schemas: new Map(Object.entries(spec.schemas ?? {}).map(([name, struct]) => [name, fromStruct(struct)]))
    }
  })
})

export class DuplicateAdapter extends Error {}

/** The adapters this process can assemble agents from: every pack built once, names unique across packs. */
export class Adapters extends Context.Service<Adapters, Registry>()("atomic-agents/Adapters") {
  static readonly make = (packs: ReadonlyArray<Pack>) =>
    Layer.effect(
      Adapters,
      Effect.gen(function*() {
        const built = yield* Effect.forEach(packs, (candidate) => candidate.build)
        const merged = { models: new Map(), tools: new Map(), sources: new Map(), checks: new Map(), steps: new Map(), schemas: new Map() } as {
          [K in AdapterKind]: Map<string, Registry[K] extends ReadonlyMap<string, infer V> ? V : never>
        }
        for (const registry of built) {
          for (const kind of Object.keys(merged) as ReadonlyArray<AdapterKind>) {
            for (const [name, adapter] of registry[kind]) {
              // Two packs claiming one name is a programming error in the host's pack list.
              if (merged[kind].has(name)) return yield* Effect.die(new DuplicateAdapter(`two ${kind} adapters named ${name}`))
              ;(merged[kind] as Map<string, unknown>).set(name, adapter)
            }
          }
        }
        return Adapters.of(merged)
      })
    )
}
