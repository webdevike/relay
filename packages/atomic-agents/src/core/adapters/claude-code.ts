import { Clock, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { pack } from "../Adapter.ts";
import { exec } from "../exec.ts";
import { type GenerateRequest, ModelError, type Tokens } from "../Model.ts";
import { harnessEffort, nativeModel } from "./harness.ts";

const ClaudeResult = Schema.Struct({
  type: Schema.Literal("result"),
  is_error: Schema.Boolean,
  result: Schema.optional(Schema.String),
  total_cost_usd: Schema.optional(Schema.Number),
  usage: Schema.optional(
    Schema.Struct({
      input_tokens: Schema.optional(Schema.Number),
      cache_creation_input_tokens: Schema.optional(Schema.Number),
      cache_read_input_tokens: Schema.optional(Schema.Number),
      output_tokens: Schema.optional(Schema.Number),
    }),
  ),
});
const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeResult));

/** `claude -p --output-format json`'s result object → the reply, its list-price cost and tokens, or why it failed. */
export const parseClaude = (
  stdout: string,
):
  | { readonly ok: true; readonly text: string; readonly cost: number; readonly tokens: Tokens }
  | { readonly ok: false; readonly message: string } => {
  const found = decodeResult(stdout.trim());
  if (Option.isNone(found)) return { ok: false, message: "no result object" };
  const result = found.value;
  if (result.is_error) return { ok: false, message: result.result || "claude reported an error" };
  const text = result.result ?? "";
  if (text.trim() === "") return { ok: false, message: "empty reply" };
  const usage = result.usage ?? {};
  return {
    ok: true,
    text,
    cost: result.total_cost_usd ?? 0,
    tokens: {
      input: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      output: usage.output_tokens ?? 0,
      cachedInput: usage.cache_read_input_tokens ?? 0,
    },
  };
};

/**
 * The `claude-code` harness: one `claude -p` turn (Claude Code, Isaac's Claude subscription: `ANTHROPIC_API_KEY` is
 * removed so it signs in with his account) from an empty temp dir. Claude Code keeps its own system prompt and the
 * agent's is appended; no tools, settings files, MCP servers, slash commands or saved session. It cannot attach files
 * with tools off, so a request with files fails. Cost is what Claude Code reports at list prices.
 */
export const claudeCode = pack({
  name: "claude-code",
  layer: Layer.empty,
  models: [
    {
      name: "claude-code",
      description:
        "One model turn in Claude Code (`claude -p --output-format json`, its system prompt kept, agent system appended, no tools); Anthropic models only, no attached files.",
      generate: (request: GenerateRequest) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const started = yield* Clock.currentTimeMillis;
          const fail = (message: string) => new ModelError({ model: request.model, message });
          const model = nativeModel(request.model, ["anthropic"]);
          if (model === undefined)
            return yield* fail("the claude-code harness runs Anthropic models only");
          if ((request.files ?? []).length > 0) {
            return yield* fail(
              "the claude-code harness runs with tools off and cannot attach files",
            );
          }
          const effort = harnessEffort(request.thinking);
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "atomic-agent-claude-" });
              return yield* exec(
                "claude",
                [
                  "-p",
                  "--output-format",
                  "json",
                  "--model",
                  model,
                  ...(effort === undefined ? [] : ["--effort", effort]),
                  "--tools",
                  "",
                  "--append-system-prompt",
                  request.system,
                  "--setting-sources",
                  "",
                  "--strict-mcp-config",
                  "--disable-slash-commands",
                  "--no-session-persistence",
                  request.prompt,
                ],
                { cwd, env: { ANTHROPIC_API_KEY: undefined } },
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
          const reply = parseClaude(result.stdout);
          if (!reply.ok) {
            return yield* fail(
              `${reply.message}${result.exitCode === 0 ? "" : ` (claude exited ${result.exitCode}: ${(result.stderr || result.stdout).slice(-800)})`}`,
            );
          }
          return {
            text: reply.text,
            model: request.model,
            provider: "claude-code",
            seconds: ((yield* Clock.currentTimeMillis) - started) / 1000,
            cost: reply.cost,
            tokens: reply.tokens,
          };
        }),
    },
  ],
});
