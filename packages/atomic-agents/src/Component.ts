import { Context, Effect, Layer, Schema } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import type { JournalError } from "./Event.ts"
import type { ModelRunner } from "./Model.ts"

/**
 * An atomic agent component: ONE narrow agent (minimal prompt, knowledge, tools, best model),
 * the jobs that wake it, and the typed events it emits. Nothing else talks to it directly:
 * assistants and Relay subscribe to its events and request work by emitting the events its
 * jobs listen for.
 */
export interface Component<R = never> {
  /** Kebab-case id; prefixes every event type (`<id>/<name>`). */
  readonly id: string
  /** One sentence. If it needs two, it is two components. */
  readonly purpose: string
  readonly agent: Agent
  /** Event name → schema of `data`. The component's whole output contract. */
  readonly events: EventSchemas
  readonly jobs: ReadonlyArray<Job<R | BunServices>>
  /** The component's tools as Effect services, built on platform services only. */
  readonly tools: Layer.Layer<R, never, BunServices>
}

/** A component with its tools sealed in: what a runtime registers. */
export interface Registered extends Omit<Component, "jobs" | "tools"> {
  readonly jobs: ReadonlyArray<Job<BunServices>>
}

/** The built-in components with their code defaults, provided once by the host process (CLI, Relay host, tests). `config.json` overrides them per component (`Settings.ts`). */
export class Components extends Context.Service<Components, ReadonlyArray<Registered>>()("atomic-agents/Components") {}

export const define = <R>(component: Component<R>): Registered => ({
  id: component.id,
  purpose: component.purpose,
  agent: component.agent,
  events: component.events,
  jobs: component.jobs.map((job) => ({
    ...job,
    start: (input, context) => job.start(input, context).pipe(Effect.provide(component.tools))
  }))
})

export interface Agent {
  /** Code default model (omp id); `config.json` `components.<id>.model` overrides it, and `atomic-agents use` writes that after a bake-off. */
  readonly model: string
  readonly candidates: ReadonlyArray<string>
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high"
  /** System prompt with the component's knowledge inlined. Kept small on purpose. */
  readonly system: string
}

/** Event name → schema of its `data`. Encoders must not need services, so any process can validate. */
export type EventSchemas = Readonly<Record<string, Schema.Encoder<unknown>>>

export type Trigger =
  | { readonly _tag: "Manual" }
  /** Cron expression (local time); `input` yields the job input in its encoded (JSON) form. */
  | { readonly _tag: "Cron"; readonly cron: string; readonly input: Effect.Effect<unknown> }
  /** Run on every event of this full type; the event's `data` is the job input. */
  | { readonly _tag: "OnEvent"; readonly type: string }

export const Manual: Trigger = { _tag: "Manual" }
export const Cron = (cron: string, input: Effect.Effect<unknown>): Trigger => ({ _tag: "Cron", cron, input })
export const OnEvent = (type: string): Trigger => ({ _tag: "OnEvent", type })

/** A job failure the runtime can report: every tagged error with a message qualifies. */
export interface Failure {
  readonly _tag: string
  readonly message: string
}

export interface JobContext<E extends EventSchemas> {
  readonly component: string
  readonly job: string
  readonly run: string
  /** Private, created per run: artifacts (images, scripts, logs) go here. */
  readonly runDir: string
  /** The resolved model for this run (bake-off override, else config.json, else `agent.model`). */
  readonly model: string
  /** The agent with config.json overrides applied. */
  readonly agent: Agent
  emit<K extends keyof E & string>(name: K, data: E[K]["Type"]): Effect.Effect<void, JournalError | Schema.SchemaError>
}

/** Type-erased job the runtime schedules; build it with `job()`. */
export interface Job<R> {
  readonly id: string
  readonly description: string
  readonly input: Schema.Top
  readonly triggers: ReadonlyArray<Trigger>
  start(input: unknown, context: JobContext<EventSchemas>): Effect.Effect<unknown, Failure | Schema.SchemaError, R | ModelRunner>
}

/** Declare a job against a component's event schemas so `ctx.emit` is typed. */
export const job = <E extends EventSchemas, I extends Schema.Decoder<unknown>, R>(
  _events: E,
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
  start: (input, context) =>
    Schema.decodeUnknownEffect(spec.input)(input).pipe(
      // The runtime validates `emit` against `_events`, so the erased context is safe to narrow.
      Effect.flatMap((decoded) => spec.run(decoded, context as unknown as JobContext<E>))
    )
})
