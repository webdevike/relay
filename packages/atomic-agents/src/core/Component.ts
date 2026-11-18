import { type Config, Data, Effect, Layer, Path, PlatformError, Schema, type Scope } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import type { Asks } from "./Ask.ts";
import type { JournalError } from "./Event.ts";
import type { ModelRunner } from "./Model.ts";

/** A component's id and its declared events: enough to name its event types at compile time. */
export interface Contract<C extends string = string, E extends EventSchemas = EventSchemas> {
  /** Kebab-case id; prefixes every event type (`<id>/<name>`). */
  readonly id: C;
  /** Event name → schema of `data`. The component's whole output contract. */
  readonly events: E;
}

/** `<component>/<event>`, for a name the contract declares. */
export const eventType = <C extends string, E extends EventSchemas, K extends keyof E & string>(
  contract: Contract<C, E>,
  name: K,
): `${C}/${K}` => `${contract.id}/${name}`;

/** Building a component's tools may fail on config (`Config`) or files (knowledge, scripts); the agent then fails to load. */
export type ToolsError = Config.ConfigError | PlatformError.PlatformError;

/** A file shipped next to a component module (knowledge, scripts), as a path: `moduleFile(import.meta.url, "./stage.py")`. */
export const moduleFile = (moduleUrl: string, name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* path
      .fromFileUrl(new URL(name, moduleUrl))
      .pipe(Effect.mapError((reason) => new PlatformError.PlatformError(reason)));
  });

/**
 * An atomic agent component in code: ONE narrow agent (minimal prompt, knowledge, tools, best model),
 * the jobs that wake it, and the typed events it emits. Nothing else talks to it directly:
 * assistants and Relay subscribe to its events and request work by emitting the events its
 * jobs listen for. Code is the escape hatch: an agent file (`Agent.ts`, `kind: "code"`) points at one
 * when the standard agent spec (`AgentSpec.ts`) does not fit; agent specs compile to this same shape.
 */
export interface Component<R = never> extends Contract {
  /** One sentence. If it needs two, it is two components. */
  readonly purpose: string;
  readonly agent: AgentSettings;
  readonly jobs: ReadonlyArray<Job<R | BunServices>>;
  /** The component's tools as Effect services, built on platform services only, once per runtime. */
  readonly tools: Layer.Layer<R, ToolsError, BunServices>;
  /** The request/response pair callers `ask` (see `Ask.ts`), when the component answers requests. */
  readonly asks?: Asks;
  /**
   * How a trial (`Trial.ts`) runs this code agent: absent, each arm is its own run on its model in parallel; `inline`,
   * the default run gets the other arms in `ctx.trial` and reports their results itself (an agent whose run holds one
   * shared resource, e.g. Soundly's signed-in app, that three runs at once would fight over).
   */
  readonly trialArms?: "inline";
}

/** A job as the runtime sees it before its tools exist: schedule and input, no body. */
export type JobInfo = Omit<Job<never>, "start">;

/** A component with its tools hidden: what a runtime registers. */
export interface Registered extends Contract {
  readonly purpose: string;
  readonly agent: AgentSettings;
  readonly jobs: ReadonlyArray<JobInfo>;
  readonly asks?: Asks;
  readonly trialArms?: "inline";
  /** Build the tools once, in the caller's scope, and answer the jobs with them provided. */
  readonly build: Effect.Effect<
    ReadonlyArray<Job<BunServices>>,
    ToolsError,
    BunServices | Scope.Scope
  >;
}

export const define = <R>(component: Component<R>): Registered => ({
  id: component.id,
  purpose: component.purpose,
  agent: component.agent,
  events: component.events,
  jobs: component.jobs,
  ...(component.asks === undefined ? {} : { asks: component.asks }),
  ...(component.trialArms === undefined ? {} : { trialArms: component.trialArms }),
  build: Effect.map(Layer.build(component.tools), (tools) =>
    component.jobs.map((job) => ({
      ...job,
      start: (input, context) => job.start(input, context).pipe(Effect.provideContext(tools)),
    })),
  ),
});

/**
 * How an agent's model uses its tools: one tool call per model turn (`tools`), or one TypeScript script per turn
 * against the tools as typed functions, run in a sandbox (`code`, `CodeMode.ts`). When to pick which: `docs/code-mode.md`.
 */
export const ToolMode = Schema.Literals(["tools", "code"]);
export type ToolMode = typeof ToolMode.Type;

/**
 * What one value of a request field changes about a run: the model, thinking level and budget the agent runs with
 * (`AgentSettings.tiers`). `maxSteps` is model calls in the tool loop, `timeout` seconds per model call; absent
 * means the agent file's own. `candidates` are the models a trial compares inside this tier (default: the agent's).
 */
export interface Tier {
  readonly model: string;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high";
  readonly maxSteps?: number;
  readonly timeout?: number;
  readonly candidates?: ReadonlyArray<string>;
}

/** A request field (`by`, a string field of the job input) picks a tier by value; an absent or empty field is `default`. */
export interface Tiers {
  readonly by: string;
  readonly default: string;
  readonly levels: Readonly<Record<string, Tier>>;
}

/** The budget a tier gives one run: what the agent spec's tool loop and model calls use in place of the file's. */
export interface Budget {
  readonly maxSteps?: number;
  readonly timeout?: number;
}

export interface AgentSettings {
  /** Code default model (omp id); `config.json` `components.<id>.model` overrides it, and `atomic-agents use` writes that after a bake-off. */
  readonly model: string;
  readonly candidates: ReadonlyArray<string>;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high";
  /**
   * Code default tool mode, present only for an agent whose model calls tools (an agent spec with `job.tools`); an agent
   * without tools has none. `config.json` `components.<id>.toolMode` overrides it, live, like the model.
   */
  readonly toolMode?: ToolMode;
  /**
   * Per-request tiers: the value of one request field picks the model, thinking and budget (`Settings.effective(...).tier`).
   * `model` and `thinking` above are the defaults for a request no tier covers; a tier overrides them, and
   * `config.json` `components.<id>.model` / `thinking` still override a tier (one explicit model for every request).
   */
  readonly tiers?: Tiers;
  /**
   * A taste agent whose model Isaac picks blind (`Trial.ts`): with `trial` on, each caller's request also runs on the
   * other trial models in parallel and Relay shows the results as A / B / C. Needs 3 models among `model` and
   * `candidates`; `config.json` `components.<id>.trial` / `trialModels` override it live.
   */
  readonly trial?: boolean;
  /** System prompt. Kept small on purpose; knowledge files load in the component's tools layer. */
  readonly system: string;
}

/** Event name → schema of its `data`. Encoders must not need services, so any process can validate. */
export type EventSchemas = Readonly<Record<string, Schema.Encoder<unknown>>>;

export type Trigger = Data.TaggedEnum<{
  Manual: {};
  /** Cron expression (local time); `input` yields the job input in its encoded (JSON) form. */
  Cron: { readonly cron: string; readonly input: Effect.Effect<unknown> };
  /** Run on every event of this full type; the event's `data` is the job input. Build it with `OnEvent`. */
  OnEvent: { readonly type: string };
}>;
export const Trigger = Data.taggedEnum<Trigger>();

/** Run on every `name` event of `contract`: a name the contract does not declare is a compile error. */
export const OnEvent = <C extends string, E extends EventSchemas>(
  contract: Contract<C, E>,
  name: keyof E & string,
): Trigger => Trigger.OnEvent({ type: eventType(contract, name) });

/** A job failure the runtime can report: every tagged error with a message qualifies. */
export interface Failure {
  readonly _tag: string;
  readonly message: string;
}

/** What the runtime hands each run; `job()` turns it into the job's typed `JobContext`. */
export interface RunContext {
  readonly component: string;
  readonly job: string;
  readonly run: string;
  /** Private, created per run: artifacts (images, scripts, logs) go here. */
  readonly runDir: string;
  /** Persistent across runs, created before each run: cursors and other state a job carries forward go here. */
  readonly stateDir: string;
  /** The tier's step and time budget for this run (`AgentSettings.tiers`); absent without a tier. */
  readonly budget?: Budget;
  /** The resolved model for this run (bake-off override, else config.json, else `agent.model`). */
  readonly model: string;
  /** The resolved tool mode for this run (bake-off override, else config.json, else `agent.toolMode`); absent for an agent without tools. */
  readonly toolMode?: ToolMode;
  /** The agent with config.json overrides applied. */
  readonly agent: AgentSettings;
  /** Append `<component>/<name>` with `data` already encoded by the event's schema. */
  publish(name: string, data: unknown): Effect.Effect<void, JournalError>;
  /** Set on a trial's run of an agent with `trialArms: "inline"`: the other arms, which the job runs and reports itself. */
  readonly trial?: InlineTrial;
}

/** What an inline-trial job gets: the other arms' letters and models, and how to report each one's result. */
export interface InlineTrial {
  readonly id: string;
  readonly letter: string;
  readonly others: ReadonlyArray<{ readonly letter: string; readonly model: string }>;
  /** One arm finished: `preview` is its result as Markdown for the card (never the model's name). */
  report(
    letter: string,
    outcome: {
      readonly ok: boolean;
      readonly preview?: string;
      readonly error?: string;
      readonly seconds: number;
      readonly cost?: number;
    },
  ): Effect.Effect<void, JournalError>;
}

export interface JobContext<E extends EventSchemas> extends Omit<RunContext, "publish"> {
  emit<K extends keyof E & string>(
    name: K,
    data: E[K]["Type"],
  ): Effect.Effect<void, JournalError | Schema.SchemaError>;
}

/** Type-erased job the runtime schedules; build it with `job()`. */
export interface Job<R> {
  readonly id: string;
  readonly description: string;
  readonly input: Schema.Top;
  readonly triggers: ReadonlyArray<Trigger>;
  start(
    input: unknown,
    context: RunContext,
  ): Effect.Effect<unknown, Failure | Schema.SchemaError, R | ModelRunner>;
}

/** Declare a job against a component's event schemas: `ctx.emit` takes only declared names and encodes with their schemas. */
export const job = <E extends EventSchemas, I extends Schema.Decoder<unknown>, R>(
  events: E,
  spec: {
    readonly id: string;
    readonly description: string;
    readonly input: I;
    readonly triggers: ReadonlyArray<Trigger>;
    readonly run: (
      input: I["Type"],
      context: JobContext<E>,
    ) => Effect.Effect<unknown, Failure | JournalError | Schema.SchemaError, R | ModelRunner>;
  },
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
            const schema = events[name];
            // `name` is typed as a declared key; only a cast past `JobContext<E>` reaches this.
            if (schema === undefined) return Effect.die(new Error(`event ${name} is not declared`));
            return Schema.encodeUnknownEffect(schema)(data).pipe(
              Effect.flatMap((encoded) => publish(name, encoded)),
            );
          },
        }),
      ),
    ),
});
