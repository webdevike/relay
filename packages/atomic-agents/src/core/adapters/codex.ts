import { Clock, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { pack } from "../Adapter.ts";
import { exec } from "../exec.ts";
import { type GenerateRequest, ModelError, type Tokens } from "../Model.ts";
import { harnessEffort, nativeModel } from "./harness.ts";

/**
 * Codex features turned off so no tool works: the reply is the whole answer, as with `omp -p --no-tools`.
 * Codex cannot drop every tool definition (code mode `exec` and the collaboration tools stay listed);
 * with these off, a call to one fails and the model answers in text.
 */
const FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "code_mode_host",
  "multi_agent",
  "apps",
  "plugins",
  "browser_use",
  "computer_use",
  "image_generation",
  "view_image",
  "sleep_tool",
  "skill_search",
  "tool_suggest",
  "goals",
  "hooks",
  "in_app_browser",
];

const CodexEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("item.completed"),
    item: Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.completed"),
    usage: Schema.Struct({
      input_tokens: Schema.Number,
      cached_input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.Number,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.failed"),
    error: Schema.Struct({ message: Schema.String }),
  }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(CodexEvent));

/**
 * A `codex exec --json` event stream → the last agent message and the summed usage, or why it failed.
 * Codex counts cache reads inside `input_tokens`; `Tokens.input` is the uncached part.
 */
export const parseCodex = (
  stdout: string,
):
  | { readonly ok: true; readonly text: string; readonly tokens: Tokens }
  | { readonly ok: false; readonly message: string } => {
  const events = stdout.split("\n").flatMap((line) => Option.toArray(decodeEvent(line)));
  const turns = events.flatMap((event) => (event.type === "turn.completed" ? [event.usage] : []));
  const failure = events
    .flatMap((event) =>
      event.type === "turn.failed"
        ? [event.error.message]
        : event.type === "error"
          ? [event.message]
          : [],
    )
    .at(-1);
  if (turns.length === 0) return { ok: false, message: failure ?? "no completed turn" };
  const reply =
    events
      .flatMap((event) =>
        event.type === "item.completed" && event.item.type === "agent_message"
          ? [event.item.text ?? ""]
          : [],
      )
      .at(-1) ?? "";
  if (reply.trim() === "") return { ok: false, message: "empty reply" };
  const sum = (pick: (usage: (typeof turns)[number]) => number) =>
    turns.reduce((total, usage) => total + pick(usage), 0);
  return {
    ok: true,
    text: reply,
    tokens: {
      input: sum((usage) => usage.input_tokens - (usage.cached_input_tokens ?? 0)),
      output: sum((usage) => usage.output_tokens),
      cachedInput: sum((usage) => usage.cached_input_tokens ?? 0),
    },
  };
};

const CatalogEntry = Schema.Struct({
  selector: Schema.String,
  id: Schema.String,
  cost: Schema.Struct({ input: Schema.Number, output: Schema.Number, cacheRead: Schema.Number }),
});
const decodeCatalog = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ models: Schema.Array(CatalogEntry) })),
);

/**
 * The `codex` harness: one `codex exec` turn (Codex CLI, Isaac's ChatGPT subscription) from an empty temp dir.
 * Codex keeps its own base instructions; the agent's system prompt goes in as developer instructions. No user
 * config, rules, session, sandbox writes or web search; tools off (`FEATURES_OFF`). Images attach with `-i`.
 * Cost is the reported tokens at omp's catalog rates for the model, as omp prices its own calls.
 */
export const codex = pack({
  name: "codex",
  layer: Layer.empty,
  models: [
    {
      name: "codex",
      description:
        "One model turn in Codex CLI (`codex exec --json`, its base instructions kept, agent system as developer instructions, tools off); OpenAI models only.",
      generate: (request: GenerateRequest) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const started = yield* Clock.currentTimeMillis;
          const fail = (message: string) => new ModelError({ model: request.model, message });
          const model = nativeModel(request.model, ["openai-codex", "openai"]);
          if (model === undefined) return yield* fail("the codex harness runs OpenAI models only");
          const effort = harnessEffort(request.thinking);
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "atomic-agent-codex-" });
              return yield* exec(
                "codex",
                [
                  "exec",
                  "--json",
                  "--ephemeral",
                  "--skip-git-repo-check",
                  "--ignore-user-config",
                  "--ignore-rules",
                  "--sandbox",
                  "read-only",
                  "--cd",
                  cwd,
                  "--model",
                  model,
                  ...(effort === undefined ? [] : ["-c", `model_reasoning_effort="${effort}"`]),
                  "-c",
                  'web_search="disabled"',
                  "-c",
                  "include_apply_patch_tool=false",
                  // A JSON string is a valid TOML basic string, so the system prompt arrives verbatim.
                  "-c",
                  `developer_instructions=${JSON.stringify(request.system)}`,
                  ...FEATURES_OFF.flatMap((feature) => ["--disable", feature]),
                  request.prompt,
                  ...(request.files ?? []).flatMap((file) => ["--image", file]),
                ],
                { cwd, env: { OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined } },
              );
            }),
          ).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.timeoutOrElse({
              duration: request.timeout ?? "5 minutes",
              orElse: () => Effect.fail(fail("timed out")),
            }),
            Effect.catchTag("PlatformError", (error) => Effect.fail(fail(error.message))),
          );
          const seconds = ((yield* Clock.currentTimeMillis) - started) / 1000;
          const reply = parseCodex(result.stdout);
          if (!reply.ok)
            return yield* fail(
              `${reply.message}${result.exitCode === 0 ? "" : ` (codex exited ${result.exitCode}: ${result.stderr.slice(-800)})`}`,
            );
          const catalog = yield* exec("omp", ["models", "ls", model, "--json"]).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.map((listed) => decodeCatalog(listed.stdout)),
            Effect.catchTag("PlatformError", () => Effect.succeed(Option.none())),
          );
          const entries = Option.match(catalog, {
            onNone: () => [],
            onSome: (found) => found.models,
          });
          const rates = (
            entries.find((entry) => entry.selector === request.model) ??
            entries.find((entry) => entry.id === model)
          )?.cost;
          if (rates === undefined) return yield* fail(`no omp catalog price for ${model}`);
          const { tokens } = reply;
          const cost =
            (tokens.input * rates.input +
              tokens.cachedInput * rates.cacheRead +
              tokens.output * rates.output) /
            1e6;
          return {
            text: reply.text,
            model: request.model,
            provider: "codex",
            seconds,
            cost,
            tokens,
          };
        }),
    },
  ],
});
