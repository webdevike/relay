import { type Config, Data, Effect, Layer, Path, PlatformError, Schema, type Scope } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import type { Asks } from "./Ask.ts"
import type { JournalError } from "./Event.ts"
import type { ModelRunner } from "./Model.ts"

/** A component's id and its declared events: enough to name its event types at compile time. */
export interface Contract<C extends string = string, E extends EventSchemas = EventSchemas> {
  /** Kebab-case id; prefixes every event type (`<id>/<name>`). */
  readonly id: C
  /** Event name → schema of `data`. The component's whole output contract. */
  readonly events: E
}

/** `<component>/<event>`, for a name the contract declares. */
export const eventType = <C extends string, E extends EventSchemas, K extends keyof E & string>(contract: Contract<C, E>, name: K): `${C}/${K}` =>
  `${contract.id}/${name}`

/** Building a component's tools may fail on config (`Config`) or files (knowledge, scripts); the chef then fails to load. */
export type ToolsError = Config.ConfigError | PlatformError.PlatformError

/** A file shipped next to a component module (knowledge, scripts), as a path: `moduleFile(import.meta.url, "./stage.py")`. */
export const moduleFile = (moduleUrl: string, name: string) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    return yield* path.fromFileUrl(new URL(name, moduleUrl)).pipe(Effect.mapError((reason) => new PlatformError.PlatformError(reason)))
  })

/**
 * An atomic agent component in code: ONE narrow agent (minimal prompt, knowledge, tools, best model),
 * the jobs that wake it, and the typed events it emits. Nothing else talks to it directly:
 * assistants and Relay subscribe to its events and request work by emitting the events its
 * jobs listen for. Code is the escape hatch: a chef file (`Chef.ts`, `kind: "code"`) points at one
 * when the standard recipe (`Recipe.ts`) does not fit; recipes compile to this same shape.
 */
export interface Component<R = never> extends Contract {
  /** One sentence. If it needs two, it is two components. */
  readonly purpose: string
  readonly agent: Agent
  readonly jobs: ReadonlyArray<Job<R | BunServices>>
  /** The component's tools as Effect services, built on platform services only, once per runtime. */
  readonly tools: Layer.Layer<R, ToolsError, BunServices>
  /** The request/response pair callers `ask` (see `Ask.ts`), when the component answers requests. */
  readonly asks?: Asks
}

/** A job as the runtime sees it before its tools exist: schedule and input, no body. */
export type JobInfo = Omit<Job<never>, "start">

/** A component with its tools hidden: what a runtime registers. */
export interface Registered extends Contract {
  readonly purpose: string
  readonly agent: Agent
  readonly jobs: ReadonlyArray<JobInfo>
  readonly asks?: Asks
  /** Build the tools once, in the caller's scope, and answer the jobs with them provided. */
  readonly build: Effect.Effect<ReadonlyArray<Job<BunServices>>, ToolsError, BunServices | Scope.Scope>
}

export const define = <R>(component: Component<R>): Registered => ({
  id: component.id,
  purpose: component.purpose,
  agent: component.agent,
  events: component.events,
  jobs: component.jobs,
  ...(component.asks === undefined ? {} : { asks: component.asks }),
  build: Effect.map(Layer.build(component.tools), (tools) =>
    component.jobs.map((job) => ({ ...job, start: (input, context) => job.start(input, context).pipe(Effect.provideContext(tools)) })))
})

export interface Agent {
  /** Code default model (omp id); `config.json` `components.<id>.model` overrides it, and `atomic-agents use` writes that after a bake-off. */
  readonly model: string
  readonly candidates: ReadonlyArray<string>
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high"
  /** System prompt. Kept small on purpose; knowledge files load in the component's tools layer. */
  readonly system: string
}

/** Event name → schema of its `data`. Encoders must not need services, so any process can validate. */
export type EventSchemas = Readonly<Record<string, Schema.Encoder<unknown>>>

export type Trigger = Data.TaggedEnum<{
  Manual: {}
  /** Cron expression (local time); `input` yields the job input in its encoded (JSON) form. */
  Cron: { readonly cron: string; readonly input: Effect.Effect<unknown> }
  /** Run on every event of this full type; the event's `data` is the job input. Build it with `OnEvent`. */
  OnEvent: { readonly type: string }
}>
export const Trigger = Data.taggedEnum<Trigger>()

/** Run on every `name` event of `contract`: a name the contract does not declare is a compile error. */
export const OnEvent = <C extends string, E extends EventSchemas>(contract: Contract<C, E>, name: keyof E & string): Trigger =>
  Trigger.OnEvent({ type: eventType(contract, name) })

/** A job failure the runtime can report: every tagged error with a message qualifies. */
export interface Failure {
  readonly _tag: string
  readonly message: string
}

/** What the runtime hands each run; `job()` turns it into the job's typed `JobContext`. */
export interface RunContext {
  readonly component: string
  readonly job: string
  readonly run: string
  /** Private, created per run: artifacts (images, scripts, logs) go here. */
  readonly runDir: string
  /** Persistent across runs, created before each run: cursors and other state a job carries forward go here. */
  readonly stateDir: string
  /** The resolved model for this run (bake-off override, else config.json, else `agent.model`). */
  readonly model: string
  /** The agent with config.json overrides applied. */
  readonly agent: Agent
  /** Append `<component>/<name>` with `data` already encoded by the event's schema. */
  publish(name: string, data: unknown): Effect.Effect<void, JournalError>
}

export interface JobContext<E extends EventSchemas> extends Omit<RunContext, "publish"> {
  emit<K extends keyof E & string>(name: K, data: E[K]["Type"]): Effect.Effect<void, JournalError | Schema.SchemaError>
}

/** Type-erased job the runtime schedules; build it with `job()`. */
export interface Job<R> {
  readonly id: string
  readonly description: string
  readonly input: Schema.Top
  readonly triggers: ReadonlyArray<Trigger>
  start(input: unknown, context: RunContext): Effect.Effect<unknown, Failure | Schema.SchemaError, R | ModelRunner>
}

/** Declare a job against a component's event schemas: `ctx.emit` takes only declared names and encodes with their schemas. */
export const job = <E extends EventSchemas, I extends Schema.Decoder<unknown>, R>(
  events: E,
  spec: {
    readonly id: string
    readonly description: string
    readonly input: I
    readonly triggers: ReadonlyArray<Trigger>
    readonly run: (input: I["Type"], context: JobContext<E>) => Effect.Effect<unknown, Failure | JournalError | Schema.SchemaError, R | ModelRunner>
  }
): Job<R> => ({
  id: spec.id,
  description: spec.description,
  input: spec.input,
  triggers: spec.triggers,
  start: (input, { publish, ...context }) =>
    Schema.decodeUnknownEffect(spec.input)(input).pipe(
      Effect.flatMap((decoded) =>
        spec.run(decoded, {
          ...context,
          emit: (name, data) => {
            const schema = events[name]
            // `name` is typed as a declared key; only a cast past `JobContext<E>` reaches this.
            if (schema === undefined) return Effect.die(new Error(`event ${name} is not declared`))
            return Schema.encodeUnknownEffect(schema)(data).pipe(Effect.flatMap((encoded) => publish(name, encoded)))
          }
        }))
    )
})
