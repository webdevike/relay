import { extname } from "node:path";
import {
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  Fiber,
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
import { isObject } from "./Fields.ts";
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
  /** The omp profile this call runs under (`OMP_PROFILE` in omp's environment); absent: the process's own. */
  readonly profile?: string;
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

/** An assistant message as omp reports it (`message_end`), in `-p --mode json` and in `--mode rpc` alike. */
const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  provider: Schema.String,
  stopReason: Schema.optional(Schema.NullOr(Schema.String)),
  errorMessage: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
      /** A `toolCall` part's tool. */
      name: Schema.optional(Schema.String),
    }),
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
const decodeAssistant = Schema.decodeUnknownOption(AssistantMessage);
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

/** A JSON Schema object, as `Schema.toJsonSchemaDocument` writes one and a provider's tool calling reads one. */
export type JsonSchema = { readonly [key: string]: unknown };

/** The tool that ends a native tool session: its args are the final answer. */
export const ANSWER_TOOL = "answer";
/**
 * Output one model call of a native tool session may stream before the runtime stops it, in tokens, counted as
 * 4 characters a token over its text, thinking and tool-call deltas (omp sets no provider-side cap per call).
 */
export const MAX_OUTPUT_TOKENS = 16_000;
const CHARS_PER_TOKEN = 4;
/** Told to the model with the tool results of its second-to-last model call. */
const LAST_CALL = `Your next model call is your last: tools close then, so call ${ANSWER_TOOL} with your final answer.`;

/** A tool as native tool calling sees it: JSON Schema args; `call` runs it in this process and never fails. */
export interface NativeTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly call: (args: unknown) => Effect.Effect<string>;
}

/** One native tool session: the request, its tools, and the answer as one more tool that ends it. */
export interface ToolSession<A> extends GenerateRequest {
  readonly tools: ReadonlyArray<NativeTool>;
  readonly answer: {
    readonly description: string;
    readonly parameters: JsonSchema;
    /** The answer tool's args as the answer, or why they are not one (fed back to the model). */
    readonly decode: (args: unknown) => Result.Result<A, string>;
  };
  /** Model calls in the session, the answer included. */
  readonly maxSteps: number;
  /** Image paths tools produced so far; each new one goes to the model with the tool result that made it. */
  readonly attachments?: () => ReadonlyArray<string>;
}

interface ImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** The inherited environment with `overrides` on top; an `undefined` override removes the variable. */
const childEnv = (
  overrides: Readonly<Record<string, string | Redacted.Redacted<string> | undefined>>,
) => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined) env[name] = value;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = typeof value === "string" ? value : Redacted.value(value);
  }
  return env;
};

/** The last `max` characters of a stream's text, read to its end so the child never blocks on a full pipe. */
const tail = async (stream: ReadableStream<Uint8Array>, max: number) => {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream)
    text = (text + decoder.decode(chunk, { stream: true })).slice(-max);
  return text;
};

/**
 * One native tool session in `omp --mode rpc`: the tools and the answer go to omp as host tools (`set_host_tools`), so
 * the provider's own tool calling proposes the calls, several per turn, and omp hands each to this process
 * (`host_tool_call`), which runs it and returns its result (`host_tool_result`). The model never writes a tool result.
 * The session ends at the first valid `answer` call (or a final reply that is a valid answer), and fails typed and at
 * once when a model call ends with neither, streams past `MAX_OUTPUT_TOKENS`, runs past `session.timeout` (per model
 * call, tool time excluded) or would exceed `maxSteps`.
 */
const rpcToolSession = <A>(
  bin: string,
  session: ToolSession<A>,
  setup: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly viaOpenRouter: boolean;
    readonly images: ReadonlyArray<ImageContent>;
    readonly readImage: (file: string) => Effect.Effect<ImageContent, { readonly message: string }>;
    /** The session's context (its span): tool calls run in it. */
    readonly context: Context.Context<never>;
  },
) =>
  Effect.callback<ToolGeneration<A>, ModelError | ToolLoopError>((resume) => {
    const started = Date.now();
    const limitMs = Duration.toMillis(Duration.fromInputUnsafe(session.timeout ?? "5 minutes"));
    const byName = new Map(session.tools.map((candidate) => [candidate.name, candidate]));
    const calls: Array<ToolCall> = [];
    const tokens = { input: 0, output: 0, cachedInput: 0 };
    const shown = new Set<string>();
    const fibers = new Set<Fiber.Fiber<unknown>>();
    let step = 0;
    let cost = 0;
    let provider: string | undefined;
    let providerError: string | undefined;
    let streamed = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const child = Bun.spawn(
      [
        bin,
        "--mode",
        "rpc",
        "--model",
        session.model,
        "--thinking",
        session.thinking ?? "off",
        "--no-tools",
        "--no-skills",
        "--no-rules",
        "--no-extensions",
        "--no-lsp",
        "--no-session",
        "--no-title",
        "--system-prompt",
        session.system,
      ],
      { cwd: setup.cwd, env: setup.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const stop = () => {
      finished = true;
      clearTimeout(timer);
      for (const fiber of fibers) Effect.runFork(Fiber.interrupt(fiber));
      child.kill(9);
    };
    const finish = (exit: Effect.Effect<ToolGeneration<A>, ModelError | ToolLoopError>) => {
      if (finished) return;
      stop();
      resume(exit);
    };
    const modelError = (message: string) =>
      finish(Effect.fail(new ModelError({ model: session.model, message })));
    const loopError = (message: string) =>
      finish(Effect.fail(new ToolLoopError({ model: session.model, steps: step, message })));
    const answered = (answer: A) =>
      finish(
        Effect.succeed({
          answer,
          steps: step,
          calls,
          cost,
          seconds: (Date.now() - started) / 1000,
          tokens,
          ...(provider === undefined ? {} : { provider }),
        }),
      );
    const send = (frame: unknown) => {
      if (finished) return;
      child.stdin.write(`${JSON.stringify(frame)}\n`);
      void child.stdin.flush();
    };
    const reply = (
      id: string,
      text: string,
      extra: ReadonlyArray<ImageContent | { readonly type: "text"; readonly text: string }> = [],
      isError = false,
    ) =>
      send({
        type: "host_tool_result",
        id,
        result: { content: [{ type: "text", text }, ...extra] },
        ...(isError ? { isError: true } : {}),
      });
    /** Images tools made since the last result, as content for the next one. */
    const freshImages = Effect.suspend(() => {
      const paths = (session.attachments?.() ?? []).filter((path) => !shown.has(path));
      for (const path of paths) shown.add(path);
      return Effect.forEach(paths, (path) =>
        setup.readImage(path).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              type: "text" as const,
              text: `image not attached: ${error.message}`,
            }),
          ),
        ),
      );
    });
    /** A final reply written as text instead of an answer call: the answer object itself, or `{"answer": ...}` around it. */
    const textAnswer = (text: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonObject(text));
      } catch {
        return undefined;
      }
      const direct = session.answer.decode(parsed);
      if (Result.isSuccess(direct) || !isObject(parsed) || !("answer" in parsed)) return direct;
      return session.answer.decode(parsed["answer"]);
    };

    const onAssistant = (raw: unknown) => {
      const decoded = decodeAssistant(raw);
      if (Option.isNone(decoded)) return;
      const message = decoded.value;
      clearTimeout(timer);
      tokens.input += (message.usage?.input ?? 0) + (message.usage?.cacheWrite ?? 0);
      tokens.output += message.usage?.output ?? 0;
      tokens.cachedInput += message.usage?.cacheRead ?? 0;
      cost += message.usage?.cost?.total ?? 0;
      provider = message.provider;
      if ((provider === "openrouter") !== setup.viaOpenRouter)
        return modelError(
          `served by ${provider}, expected ${setup.viaOpenRouter ? "openrouter" : "a native provider"}`,
        );
      // omp retries a provider error on its own; the session's end reports it when no retry answered.
      if (message.stopReason === "error") {
        providerError = message.errorMessage ?? "provider error";
        return;
      }
      if (message.stopReason === "aborted") return;
      step++;
      if (message.stopReason === "length")
        return loopError(`model call ${step} hit the provider's output limit`);
      const toolCalls = message.content.filter((part) => part.type === "toolCall");
      if (toolCalls.length === 0) {
        const text = message.content
          .flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
          .join("")
          .trim();
        const answer = textAnswer(text);
        return answer !== undefined && Result.isSuccess(answer)
          ? answered(answer.success)
          : loopError(
              `model call ${step} ended with no tool call and no answer${text === "" ? "" : `: ${text.slice(0, 300)}`}`,
            );
      }
      if (step >= session.maxSteps && !toolCalls.some((part) => part.name === ANSWER_TOOL))
        return loopError(`no answer in ${session.maxSteps} model calls`);
    };

    const onToolCall = (frame: Readonly<Record<string, unknown>>) => {
      const id = String(frame["id"]);
      const name = String(frame["toolName"]);
      const args = frame["arguments"];
      if (name === ANSWER_TOOL) {
        const answer = session.answer.decode(args);
        if (Result.isSuccess(answer)) {
          reply(id, "Answer recorded.");
          return answered(answer.success);
        }
        if (step >= session.maxSteps)
          return loopError(`bad answer in the last model call: ${answer.failure}`);
        return reply(id, `error: bad answer: ${answer.failure}`, [], true);
      }
      const found = byName.get(name);
      calls.push({ tool: name, allowed: found !== undefined });
      if (step >= session.maxSteps)
        return reply(id, `error: tools are closed; call ${ANSWER_TOOL} now`, [], true);
      if (found === undefined)
        return reply(
          id,
          `error: no tool ${name}; you may only call: ${[...byName.keys()].join(", ")}`,
          [],
          true,
        );
      const last = step === session.maxSteps - 1;
      const fiber = Effect.runForkWith(setup.context)(
        found
          .call(args)
          .pipe(
            Effect.flatMap((text) =>
              Effect.map(freshImages, (images) =>
                reply(id, last ? `${text}\n\n${LAST_CALL}` : text, images),
              ),
            ),
          ),
      );
      fibers.add(fiber);
      fiber.addObserver(() => fibers.delete(fiber));
    };

    const onFrame = (frame: Readonly<Record<string, unknown>>) => {
      switch (frame["type"]) {
        case "ready":
          send({
            type: "set_event_filter",
            events: ["turn_start", "message_update", "message_end"],
            messageUpdates: "delta",
          });
          send({
            id: "tools",
            type: "set_host_tools",
            tools: [
              ...session.tools.map((candidate) => ({
                name: candidate.name,
                description: candidate.description,
                parameters: candidate.parameters,
                loadMode: "essential",
              })),
              {
                name: ANSWER_TOOL,
                description: session.answer.description,
                parameters: session.answer.parameters,
                loadMode: "essential",
              },
            ],
          });
          send({
            id: "prompt",
            type: "prompt",
            message: session.prompt,
            ...(setup.images.length === 0 ? {} : { images: setup.images }),
          });
          return;
        case "response":
          if (frame["success"] === false)
            modelError(`omp rpc ${String(frame["command"])} failed: ${String(frame["error"])}`);
          return;
        case "turn_start":
          streamed = 0;
          clearTimeout(timer);
          timer = setTimeout(
            () => modelError(`model call ${step + 1} timed out after ${limitMs / 1000} s`),
            limitMs,
          );
          return;
        case "message_update": {
          const event = frame["assistantMessageEvent"];
          const delta = isObject(event) ? event["delta"] : undefined;
          if (typeof delta !== "string") return;
          streamed += delta.length;
          if (streamed > MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN)
            loopError(
              `model call ${step + 1} streamed past the ${MAX_OUTPUT_TOKENS}-token output cap`,
            );
          return;
        }
        case "message_end":
          return onAssistant(frame["message"]);
        case "host_tool_call":
          return onToolCall(frame);
        case "prompt_result":
          return providerError === undefined
            ? loopError(`the model stopped after ${step} model calls without an answer`)
            : modelError(providerError);
      }
    };

    const reading = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (finished || line.trim() === "") continue;
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          if (isObject(frame)) onFrame(frame);
        }
      }
    })();
    const errors = tail(child.stderr, 2000);
    void Promise.all([child.exited, reading, errors]).then(([code, , stderr]) =>
      modelError(`omp exited ${code} before an answer: ${stderr.trim().slice(-800)}`),
    );
    return Effect.sync(stop);
  });

/**
 * One-shot model call for a component's agent. The omp implementation runs `omp -p --mode json`
 * with no tools, skills, rules, extensions or session, from an empty temp dir so no repo context
 * (AGENTS.md, Eva identity) leaks into a specialist's prompt. Auth and provider routing stay omp's.
 * `runTools` runs a native tool session in `omp --mode rpc` the same way (`rpcToolSession`).
 *
 * OpenRouter: only `openrouter/...` ids get the key (read from config.json `openRouterKeyFile` at
 * call time, else `OPENROUTER_API_KEY`), every other call runs with it removed, and Anthropic or
 * OpenAI models are refused on OpenRouter. The served provider is checked against the requested route.
 */
export class ModelRunner extends Context.Service<
  ModelRunner,
  {
    generate(request: GenerateRequest): Effect.Effect<Generation, ModelError>;
    /**
     * Native tool calling: one session in which the provider's own tool calls run `session.tools` (several per model
     * call) and the answer tool ends it. A runner without it (a harness that cannot host tools, a test fake) gets
     * `generateWithTools`' JSON loop over `generate`.
     */
    readonly runTools?: <A>(
      session: ToolSession<A>,
    ) => Effect.Effect<ToolGeneration<A>, ModelError | ToolLoopError>;
  }
>()("atomic-agents/ModelRunner") {
  /** The omp runner over the `omp` executable at `bin` (tests point it at a fake). */
  static readonly ompAt = (bin: string) =>
    Layer.effect(
      ModelRunner,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const settings = yield* Settings;
        const path = yield* Path.Path;
        const home = yield* Home;
        const keyEnv = yield* Config.option(Config.Redacted("OPENROUTER_API_KEY"));
        /** The model's route: OpenRouter or a native provider, and the env that gives omp only its key. */
        const route = Effect.fnUntraced(function* (model: string) {
          const fail = (message: string) => new ModelError({ model, message });
          const viaOpenRouter = model.startsWith(OPENROUTER);
          if (NATIVE_ONLY.test(model))
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
          return {
            viaOpenRouter,
            env: { OPENROUTER_API_KEY: key, OPENROUTER_API_KEY_FILE: undefined },
          };
        });
        // Untraced: the model adapter around it (`Adapter.ts` `pack`) opens the call's `model.call` span.
        const generate = Effect.fnUntraced(
          function* (request: GenerateRequest) {
            const started = yield* Clock.currentTimeMillis;
            const fail = (message: string) => new ModelError({ model: request.model, message });
            const { viaOpenRouter, env } = yield* route(request.model);
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "atomic-agent-" });
                return yield* exec(
                  bin,
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
                  {
                    cwd,
                    env: {
                      ...env,
                      ...(request.profile === undefined ? {} : { OMP_PROFILE: request.profile }),
                    },
                  },
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
        const readImage = (file: string) => {
          const mimeType = IMAGE_TYPES[extname(file).toLowerCase()];
          return mimeType === undefined
            ? Effect.fail({ message: `${file}: only png, jpeg, gif or webp images attach` })
            : fs.readFile(file).pipe(
                Effect.map((bytes): ImageContent => ({
                  type: "image",
                  data: Buffer.from(bytes).toString("base64"),
                  mimeType,
                })),
                Effect.mapError((error) => ({ message: `cannot read ${file}: ${error.message}` })),
              );
        };
        // Untraced like `generate`: `pack` opens the session's `model.call` span.
        const runTools = <A>(session: ToolSession<A>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const fail = (message: string) => new ModelError({ model: session.model, message });
              const { viaOpenRouter, env } = yield* route(session.model);
              const cwd = yield* fs
                .makeTempDirectoryScoped({ prefix: "atomic-agent-" })
                .pipe(Effect.mapError((error) => fail(error.message)));
              const images = yield* Effect.forEach(session.files ?? [], (file) =>
                readImage(file).pipe(Effect.mapError((error) => fail(error.message))),
              );
              return yield* rpcToolSession(bin, session, {
                cwd,
                env: childEnv({
                  ...env,
                  ...(session.profile === undefined ? {} : { OMP_PROFILE: session.profile }),
                }),
                viaOpenRouter,
                images,
                readImage,
                context: yield* Effect.context<never>(),
              });
            }),
          );
        return ModelRunner.of({ generate, runTools });
      }),
    );

  static readonly omp = ModelRunner.ompAt("omp");
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
  /** The args as JSON Schema, an object at the root: what native tool calling shows the model. */
  readonly parameters: JsonSchema;
  /** Decode the model's args and run; bad args and failures come back as text for the model, never as a run failure. */
  call(args: unknown): Effect.Effect<string, never, R>;
}

/** A schema as tool-call args: its JSON Schema with an object at the root (a no-args `Schema.Struct({})` is an empty object). */
export const toolParameters = (schema: Schema.Top): JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema);
  const definitions = document.definitions as JsonSchema;
  const ref = (document.schema as JsonSchema)["$ref"];
  const root = (
    typeof ref === "string" ? definitions[ref.split("/").at(-1)!] : document.schema
  ) as JsonSchema;
  return {
    ...(root["type"] === "object" ? root : { type: "object", properties: {} }),
    ...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions }),
  };
};

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
  parameters: toolParameters(spec.args as unknown as Schema.Top),
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
  /** Summed over the session's model calls (native tool sessions report them; the JSON loop's calls carry their own). */
  readonly tokens?: Tokens;
  /** The omp provider that served the session. */
  readonly provider?: string;
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
 * The tool loop of a tools-mode agent. A runner with `runTools` (omp) gets a native tool session: the provider's own
 * tool calling, several calls per model call, results fed back as tool results, the answer as a final `answer` tool
 * call (`rpcToolSession`). Any other runner (the codex and claude-code harnesses, test fakes) gets a JSON loop over
 * `ModelRunner.generate`: each reply is one JSON object, a tool call (`{"tool", "args"}`) that the loop runs from
 * `tools` and feeds back, or the final `{"answer"}` decoded with `answer`. In both, a tool not in `tools` never runs
 * and the model is told so; bad args, bad JSON and bad answers are fed back. At most `maxSteps` model calls, the last
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
    if (models.runTools !== undefined) {
      const context = yield* Effect.context<R>();
      const decode = Schema.decodeUnknownResult(options.answer);
      return yield* models.runTools<A>({
        ...request,
        system: [
          request.system,
          "## Tools",
          "Call tools with tool calls, several in one reply when they do not depend on each other. Their results come back to you as tool results; never write a tool result yourself.",
          `You have at most ${options.maxSteps} model calls in total, the answer included. Finish by calling ${ANSWER_TOOL} once with your final answer.`,
        ].join("\n"),
        tools: options.tools.map((candidate) => ({
          name: candidate.name,
          description: `${candidate.description}\nExample args: ${candidate.example}`,
          parameters: candidate.parameters,
          // The tool's services from here, the caller's span from the session, so `tool.call` sits under `model.call`.
          call: (args) =>
            candidate.call(args).pipe(
              Effect.map((text) => text.slice(0, RESULT_CHARS)),
              Effect.updateContext((current: Context.Context<never>) =>
                Context.merge(context, current),
              ),
            ),
        })),
        answer: {
          description: `Your final answer; calling it ends your work. Example: ${options.answerExample}`,
          parameters: toolParameters(options.answer as unknown as Schema.Top),
          decode: (args) => Result.mapError(decode(args), (error) => error.message),
        },
        maxSteps: options.maxSteps,
        ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
      });
    }
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
