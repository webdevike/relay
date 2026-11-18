import { type Cause, Effect } from "effect";
import type { Caller } from "../Adapter.ts";
import type { GenerateRequest, Generation, Tokens, ToolGeneration } from "../Model.ts";

/**
 * Span names, one set for every domain. The core opens each of them once (`Runtime.ts`, `Adapter.ts` `pack`,
 * `Model.ts` `tool`, `CodeMode.ts`, `EventBus.publish`), so an agent gets them without instrumenting anything.
 * Attributes: `agent.id`, `agent.run` and `agent.tier` on every span of a run; the rest per span (`Traces.ts` reads them).
 * Three more come from the service, not from a run: `outcome.reported` (a child of the run it reports on),
 * `schedule.missed` and `roster.check` (roots of their own trace).
 */
export const SPAN = {
  /** One `Runner.run`: the trace's root. */
  run: "agent.run",
  /** One try of the job on one model; a second one is the fallback (`fallback.from`). */
  attempt: "agent.attempt",
  /** One item of an agent spec: steps, model turns, check. */
  item: "agent.item",
  source: "source.fetch",
  step: "step.run",
  check: "check.run",
  /** One model call in a harness (`model.harness`), with tokens and cost. */
  model: "model.call",
  /** One tool call, by the model or by a code-mode script (`tool.caller`). */
  tool: "tool.call",
  /** One event appended to the journal. */
  emit: "event.emit",
  /** What a consumer did with a run's answer (`Outcomes.ts`), under that run's root. */
  outcome: "outcome.reported",
  /** A cron tick that did not start a run, or a run that hung past its deadline (`Scheduler.ts`). */
  missed: "schedule.missed",
  /** The service's roster against config.json (`Roster.ts`); a `roster.missing` child per agent it lacks. */
  roster: "roster.check",
  rosterMissing: "roster.missing",
} as const;

/** Up to `max` characters of a value, as JSON unless it is a string: what an attribute keeps of args or messages. */
export const summary = (value: unknown, max = 200) => {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** A failure as span attributes: its typed tag (a plain error object is `Error`) and its message. */
export const errorAttributes = (error: unknown) => {
  const object = typeof error === "object" && error !== null ? error : undefined;
  return {
    "error.tag":
      object && "_tag" in object && typeof object._tag === "string" ? object._tag : "Error",
    "error.message": summary(
      object && "message" in object ? String(object.message) : String(error),
      500,
    ),
  };
};

/** `effect` in span `name`; a failure also lands on the span as `error.tag` and `error.message`. */
export const traced =
  (name: string, attributes: Readonly<Record<string, unknown>> = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((error) => Effect.annotateCurrentSpan(errorAttributes(error))),
      Effect.withSpan(name, { attributes }),
    );

/** What a model call's span knows up front: harness, model, thinking, prompt size, attached files. */
const modelAttributes = (harness: string, request: GenerateRequest) => ({
  "model.harness": harness,
  "model.id": request.model,
  "prompt.chars": request.prompt.length,
  ...(request.thinking === undefined ? {} : { "model.thinking": request.thinking }),
  ...(request.files === undefined || request.files.length === 0
    ? {}
    : { "model.files": request.files.length }),
});

/** Provider, USD and tokens once a model call (or a whole tool session) answers. */
const usageAttributes = (
  provider: string | undefined,
  cost: number,
  tokens: Tokens | undefined,
) => ({
  ...(provider === undefined ? {} : { "model.provider": provider }),
  "cost.usd": cost,
  ...(tokens === undefined
    ? {}
    : {
        "tokens.input": tokens.input,
        "tokens.output": tokens.output,
        "tokens.cached": tokens.cachedInput,
      }),
});

/** A model call: harness, model and thinking up front; provider, tokens and USD once it answers. */
export const traceModel =
  (harness: string, request: GenerateRequest) =>
  <E, R>(effect: Effect.Effect<Generation, E, R>) =>
    effect.pipe(
      Effect.tap((reply) =>
        Effect.annotateCurrentSpan(usageAttributes(reply.provider, reply.cost, reply.tokens)),
      ),
      traced(SPAN.model, modelAttributes(harness, request)),
    );

/**
 * A native tool session (`ModelRunner.runTools`): one `model.call` span over all its model calls, marked
 * `model.tools native`, with the tools it offered up front and its model calls, tool calls, tokens and USD at the end.
 * The tool calls it ran are `tool.call` spans of the same item.
 */
export const traceToolSession =
  (
    harness: string,
    session: GenerateRequest & {
      readonly tools: ReadonlyArray<{ readonly name: string }>;
      readonly maxSteps: number;
    },
  ) =>
  <A, E, R>(effect: Effect.Effect<ToolGeneration<A>, E, R>) =>
    effect.pipe(
      Effect.tap((reply) =>
        Effect.annotateCurrentSpan({
          ...usageAttributes(reply.provider, reply.cost, reply.tokens),
          "model.steps": reply.steps,
          "model.tool_calls": reply.calls.length,
        }),
      ),
      traced(SPAN.model, {
        ...modelAttributes(harness, session),
        "model.tools": "native",
        "model.offered": session.tools.map((candidate) => candidate.name).join(","),
        "model.max_steps": session.maxSteps,
      }),
    );

/** A tool call: name, who called it and its args (cut to 200 characters). */
export const traceTool = (name: string, caller: Caller, args: unknown) =>
  traced(SPAN.tool, { "tool.name": name, "tool.caller": caller, "tool.args": summary(args) });

/**
 * `effect` as the run's root span. A run reports its failure as data (`answer`), so the span would end fine; with a
 * `failure` the span ends failed with that cause (its error tag as the span status) while the caller still gets `answer`.
 */
export const runSpan = <A, E, R>(
  attributes: Readonly<Record<string, unknown>>,
  effect: Effect.Effect<{ readonly answer: A; readonly failure?: Cause.Cause<unknown> }, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    let answered: { readonly value: A } | undefined;
    return effect.pipe(
      Effect.flatMap(({ answer, failure }) => {
        answered = { value: answer };
        return failure === undefined ? Effect.succeed(answer) : Effect.failCause(failure);
      }),
      Effect.withSpan(SPAN.run, { attributes }),
      Effect.catchCause((cause) =>
        answered === undefined
          ? Effect.failCause(cause as Cause.Cause<E>)
          : Effect.succeed(answered.value),
      ),
    );
  });
