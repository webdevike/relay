import {
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Result,
  Schema,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { Home } from "./Event.ts";
import { exec } from "./exec.ts";
import { traceTool } from "./observability/Spans.ts";
import { Settings } from "./Settings.ts";

export interface GenerateRequest {
  /**
   * omp model id, e.g. "anthropic/claude-sonnet-5" (fuzzy names work too). The bake-off seam.
   * `openrouter/<vendor>/<model>` goes through omp's openrouter provider (see `ModelRunner.omp`).
   */
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  /** Absolute paths passed as `@file` (images for vision models). */
  readonly files?: ReadonlyArray<string>;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high";
  readonly timeout?: Duration.Input;
}

export interface Generation {
  readonly text: string;
  readonly model: string;
  /** The omp provider that actually served the call ("anthropic", "openai-codex", "openrouter"). */
  readonly provider: string;
  readonly seconds: number;
  /** USD as omp prices the call (catalog rates, so also set for subscription providers). */
  readonly cost: number;
  /** Tokens the call used, as the harness reports them: `input` uncached (cache writes included), `cachedInput` cache reads. */
  readonly tokens?: Tokens;
}

export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly cachedInput: number;
}

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  model: Schema.String,
  message: Schema.String,
}) {}

const OPENROUTER = "openrouter/";
/** Anthropic and OpenAI models only ever run on omp's native providers. */
const NATIVE_ONLY = /^openrouter\/(anthropic|openai)\//;

/** The last assistant message of an `omp -p --mode json` event stream, plus the summed cost. */
const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  provider: Schema.String,
  stopReason: Schema.optional(Schema.NullOr(Schema.String)),
  errorMessage: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.Number),
      output: Schema.optional(Schema.Number),
      cacheRead: Schema.optional(Schema.Number),
      cacheWrite: Schema.optional(Schema.Number),
      cost: Schema.optional(Schema.Struct({ total: Schema.Number })),
    }),
  ),
});
const decodeMessageEnd = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.Literal("message_end"), message: AssistantMessage }),
  ),
);

const lastAssistant = (stdout: string) => {
  const ends = stdout.split("\n").flatMap((line) => Option.toArray(decodeMessageEnd(line)));
  const last = ends.at(-1);
  const sum = (
    pick: (usage: NonNullable<(typeof ends)[number]["message"]["usage"]>) => number | undefined,
  ) =>
    ends.reduce(
      (total, end) =>
        total + (end.message.usage === undefined ? 0 : (pick(end.message.usage) ?? 0)),
      0,
    );
  return last === undefined
    ? undefined
    : {
        message: last.message,
        cost: sum((usage) => usage.cost?.total),
        tokens: {
          input: sum((usage) => (usage.input ?? 0) + (usage.cacheWrite ?? 0)),
          output: sum((usage) => usage.output),
          cachedInput: sum((usage) => usage.cacheRead),
        },
      };
};

/**
 * One-shot model call for a component's agent. The omp implementation runs `omp -p --mode json`
 * with no tools, skills, rules, extensions or session, from an empty temp dir so no repo context
 * (AGENTS.md, Eva identity) leaks into a specialist's prompt. Auth and provider routing stay omp's.
 *
 * OpenRouter: only `openrouter/...` ids get the key (read from config.json `openRouterKeyFile` at
 * call time, else `OPENROUTER_API_KEY`), every other call runs with it removed, and Anthropic or
 * OpenAI models are refused on OpenRouter. The served provider is checked against the requested route.
 */
export class ModelRunner extends Context.Service<
  ModelRunner,
  {
    generate(request: GenerateRequest): Effect.Effect<Generation, ModelError>;
  }
>()("atomic-agents/ModelRunner") {
  static readonly omp = Layer.effect(
    ModelRunner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const settings = yield* Settings;
      const path = yield* Path.Path;
      const home = yield* Home;
      const keyEnv = yield* Config.option(Config.Redacted("OPENROUTER_API_KEY"));
      // Untraced: the model adapter around it (`Adapter.ts` `pack`) opens the call's `model.call` span.
      const generate = Effect.fnUntraced(
        function* (request: GenerateRequest) {
          const started = yield* Clock.currentTimeMillis;
          const fail = (message: string) => new ModelError({ model: request.model, message });
          const viaOpenRouter = request.model.startsWith(OPENROUTER);
          if (NATIVE_ONLY.test(request.model))
            return yield* fail(
              "Anthropic and OpenAI models run on omp's native providers, not OpenRouter",
            );
          const keyFile = viaOpenRouter ? (yield* settings.current).openRouterKeyFile : undefined;
          const key = !viaOpenRouter
            ? undefined
            : keyFile !== undefined
              ? Redacted.make(
                  (yield* fs
                    .readFileString(path.resolve(home.root, keyFile))
                    .pipe(
                      Effect.mapError(() => fail(`cannot read openRouterKeyFile ${keyFile}`)),
                    )).trim(),
                )
              : Option.getOrUndefined(keyEnv);
          if (viaOpenRouter && key === undefined)
            return yield* fail(
              `openrouter models need openRouterKeyFile in ${settings.file} or OPENROUTER_API_KEY`,
            );
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "atomic-agent-" });
              return yield* exec(
                "omp",
                [
                  "-p",
                  "--mode",
                  "json",
                  "--model",
                  request.model,
                  "--thinking",
                  request.thinking ?? "off",
                  "--no-tools",
                  "--no-skills",
                  "--no-rules",
                  "--no-extensions",
                  "--no-lsp",
                  "--no-session",
                  "--no-title",
                  "--system-prompt",
                  request.system,
                  ...(request.files ?? []).map((file) => `@${file}`),
                  request.prompt,
                ],
                { cwd, env: { OPENROUTER_API_KEY: key, OPENROUTER_API_KEY_FILE: undefined } },
              );
            }),
          ).pipe(
            Effect.timeoutOrElse({
              duration: request.timeout ?? "5 minutes",
              orElse: () => Effect.fail(fail("timed out")),
            }),
            Effect.catchTag("PlatformError", (error) => Effect.fail(fail(error.message))),
          );
          // Provider errors (401, rate limits) arrive as an errored assistant message; omp may also exit non-zero.
          const reply = lastAssistant(result.stdout);
          if (reply?.message.stopReason === "error")
            return yield* fail(reply.message.errorMessage ?? "provider error");
          if (result.exitCode !== 0)
            return yield* fail(
              `omp exited ${result.exitCode}: ${(result.stderr || result.stdout).slice(-800)}`,
            );
          if (reply === undefined)
            return yield* fail(`no assistant message: ${result.stderr.slice(-800)}`);
          const { message, cost, tokens } = reply;
          if ((message.provider === "openrouter") !== viaOpenRouter) {
            return yield* fail(
              `served by ${message.provider}, expected ${viaOpenRouter ? "openrouter" : "a native provider"}`,
            );
          }
          const text = message.content
            .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
            .join("");
          if (text.trim() === "") return yield* fail("empty reply");
          return {
            text,
            model: request.model,
            provider: message.provider,
            seconds: ((yield* Clock.currentTimeMillis) - started) / 1000,
            cost,
            tokens,
          };
        },
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      return ModelRunner.of({ generate });
    }),
  );
}

/**
 * A tool the model may call in `generateWithTools`. The model only proposes the call; the job's own
 * process runs it, so a component's tool list is its whole allowlist. Build one with `tool()`.
 */
export interface Tool<R = never> {
  readonly name: string;
  readonly description: string;
  /** The args object as the model should write it, e.g. `{"id": "<message id>"}`. */
  readonly example: string;
  /** Decode the model's args and run; bad args and failures come back as text for the model, never as a run failure. */
  call(args: unknown): Effect.Effect<string, never, R>;
}

export const tool = <
  S extends Schema.Decoder<unknown>,
  E extends { readonly message: string },
  R,
>(spec: {
  readonly name: string;
  readonly description: string;
  readonly args: S;
  readonly example: string;
  /** The result, JSON-serialisable. */
  readonly run: (args: S["Type"]) => Effect.Effect<unknown, E, R>;
}): Tool<R> => ({
  name: spec.name,
  description: spec.description,
  example: spec.example,
  call: (args) =>
    Schema.decodeUnknownEffect(spec.args)(args ?? {}).pipe(
      Effect.mapError((error) => ({ message: `bad args for ${spec.name}: ${error.message}` })),
      Effect.flatMap((decoded) => spec.run(decoded)),
      Effect.map((result) => JSON.stringify(result)),
      Effect.tap((text) => Effect.annotateCurrentSpan("tool.result_chars", text.length)),
      traceTool(spec.name, "model", args),
      Effect.catch((error) => Effect.succeed(`error: ${error.message}`)),
    ),
});

export class ToolLoopError extends Schema.TaggedError<ToolLoopError>()("ToolLoopError", {
  model: Schema.String,
  steps: Schema.Int,
  message: Schema.String,
}) {}

export interface ToolCall {
  readonly tool: string;
  /** False when the model asked for a tool it was not given: nothing ran. */
  readonly allowed: boolean;
}

export interface ToolGeneration<A> {
  readonly answer: A;
  /** Model calls made, the final answer included. */
  readonly steps: number;
  readonly calls: ReadonlyArray<ToolCall>;
  /** USD over all steps. */
  readonly cost: number;
  readonly seconds: number;
}

const Reply = Schema.Union([
  Schema.Struct({ tool: Schema.String, args: Schema.optional(Schema.Unknown) }),
  Schema.Struct({ answer: Schema.Unknown }),
]);
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply));

/** The one JSON object in a reply, fences and chatter around it ignored. */
const jsonObject = (text: string) => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
};

/** Cap on one tool result in the transcript, so a long thread cannot crowd out the message. */
const RESULT_CHARS = 6000;

/**
 * A minimal tool loop over `ModelRunner.generate`, so it works for every model and provider omp runs:
 * each reply is one JSON object, a tool call (`{"tool", "args"}`) that the loop runs from `tools` and
 * feeds back, or the final `{"answer"}` decoded with `answer`. A tool not in `tools` never runs; the
 * model is told so. Bad JSON and bad answers are fed back too. At most `maxSteps` model calls, the last
 * one told to answer; no valid answer by then is a `ToolLoopError`.
 */
export const generateWithTools = <A, R>(
  request: GenerateRequest,
  options: {
    readonly tools: ReadonlyArray<Tool<R>>;
    readonly answer: Schema.Decoder<A>;
    /** The answer object as the model should write it. */
    readonly answerExample: string;
    readonly maxSteps: number;
    /** Image paths tools produced so far, read before every model call and attached with `request.files` (vision models). */
    readonly attachments?: () => ReadonlyArray<string>;
  },
): Effect.Effect<ToolGeneration<A>, ModelError | ToolLoopError, ModelRunner | R> =>
  Effect.gen(function* () {
    const models = yield* ModelRunner;
    const started = yield* Clock.currentTimeMillis;
    const decodeAnswer = Schema.decodeUnknownEffect(options.answer);
    const allowed = options.tools.map((candidate) => candidate.name).join(", ");
    const system = [
      request.system,
      "## Replying",
      "Every reply is exactly one JSON object and nothing else, either a tool call or your final answer:",
      `- {"tool": "<name>", "args": {...}}`,
      `- {"answer": ${options.answerExample}}`,
      `You have at most ${options.maxSteps} replies in total; call a tool only when the message alone does not settle it.`,
      "Read-only tools:",
      ...options.tools.map(
        (candidate) => `- ${candidate.name} ${candidate.example}: ${candidate.description}`,
      ),
    ].join("\n");
    const transcript: Array<string> = [];
    const calls: Array<ToolCall> = [];
    let cost = 0;
    for (let step = 1; step <= options.maxSteps; step++) {
      const last = step === options.maxSteps;
      const prompt = [
        request.prompt,
        ...(transcript.length === 0
          ? []
          : ["## Your replies so far and their results", ...transcript]),
        ...(last
          ? [`This is your last reply: tools are closed, answer now with {"answer": ...}.`]
          : []),
      ].join("\n\n");
      const attached = options.attachments?.() ?? [];
      const reply = yield* models.generate({
        ...request,
        system,
        prompt,
        ...(attached.length === 0 ? {} : { files: [...(request.files ?? []), ...attached] }),
      });
      cost += reply.cost;
      const parsed = decodeReply(jsonObject(reply.text));
      const said = `[${step}] you: ${reply.text.trim().slice(0, 1000)}`;
      if (Option.isNone(parsed)) {
        transcript.push(said, `[${step}] error: not one JSON object with "tool" or "answer"`);
        continue;
      }
      if ("answer" in parsed.value) {
        const answer = yield* Effect.result(decodeAnswer(parsed.value.answer));
        if (Result.isSuccess(answer)) {
          return {
            answer: answer.success,
            steps: step,
            calls,
            cost,
            seconds: ((yield* Clock.currentTimeMillis) - started) / 1000,
          };
        }
        transcript.push(said, `[${step}] error: bad answer: ${answer.failure.message}`);
        continue;
      }
      const { tool: name, args } = parsed.value;
      const found = options.tools.find((candidate) => candidate.name === name);
      calls.push({ tool: name, allowed: found !== undefined });
      const result = last
        ? "error: tools are closed"
        : found === undefined
          ? yield* Effect.fail({ message: `no tool ${name}; you may only call: ${allowed}` }).pipe(
              traceTool(name, "model", args),
              Effect.catch((error) => Effect.succeed(`error: ${error.message}`)),
            )
          : (yield* found.call(args)).slice(0, RESULT_CHARS);
      transcript.push(said, `[${step}] result: ${result}`);
    }
    return yield* new ToolLoopError({
      model: request.model,
      steps: options.maxSteps,
      message: `no valid answer in ${options.maxSteps} model calls`,
    });
  });
