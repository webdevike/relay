import { Config, Context, Duration, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { Home } from "./Event.ts"
import { exec } from "./exec.ts"
import { Settings } from "./Settings.ts"

export interface GenerateRequest {
  /**
   * omp model id, e.g. "anthropic/claude-sonnet-5" (fuzzy names work too). The bake-off seam.
   * `openrouter/<vendor>/<model>` goes through omp's openrouter provider (see `ModelRunner.omp`).
   */
  readonly model: string
  readonly system: string
  readonly prompt: string
  /** Absolute paths passed as `@file` (images for vision models). */
  readonly files?: ReadonlyArray<string>
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high"
  readonly timeout?: Duration.Input
}

export interface Generation {
  readonly text: string
  readonly model: string
  /** The omp provider that actually served the call ("anthropic", "openai-codex", "openrouter"). */
  readonly provider: string
  readonly seconds: number
  /** USD as omp prices the call (catalog rates, so also set for subscription providers). */
  readonly cost: number
}

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  model: Schema.String,
  message: Schema.String
}) {}

const OPENROUTER = "openrouter/"
/** Anthropic and OpenAI models only ever run on omp's native providers. */
const NATIVE_ONLY = /^openrouter\/(anthropic|openai)\//

/** The last assistant message of an `omp -p --mode json` event stream, plus the summed cost. */
const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  provider: Schema.String,
  stopReason: Schema.optional(Schema.NullOr(Schema.String)),
  errorMessage: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  usage: Schema.optional(Schema.Struct({ cost: Schema.optional(Schema.Struct({ total: Schema.Number })) }))
})
const isMessageEnd = Schema.is(Schema.Struct({ type: Schema.Literal("message_end"), message: AssistantMessage }))

const lastAssistant = (stdout: string) => {
  let last: typeof AssistantMessage.Type | undefined
  let cost = 0
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!isMessageEnd(event)) continue
    last = event.message
    cost += event.message.usage?.cost?.total ?? 0
  }
  return last === undefined ? undefined : { message: last, cost }
}

/**
 * One-shot model call for a component's agent. The omp implementation runs `omp -p --mode json`
 * with no tools, skills, rules, extensions or session, from an empty temp dir so no repo context
 * (AGENTS.md, Eva identity) leaks into a specialist's prompt. Auth and provider routing stay omp's.
 *
 * OpenRouter: only `openrouter/...` ids get the key (read from config.json `openRouterKeyFile` at
 * call time, else `OPENROUTER_API_KEY`), every other call runs with it removed, and Anthropic or
 * OpenAI models are refused on OpenRouter. The served provider is checked against the requested route.
 */
export class ModelRunner extends Context.Service<ModelRunner, {
  generate(request: GenerateRequest): Effect.Effect<Generation, ModelError>
}>()("atomic-agents/ModelRunner") {
  static readonly omp = Layer.effect(
    ModelRunner,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const settings = yield* Settings
      const path = yield* Path.Path
      const home = yield* Home
      const keyEnv = yield* Config.option(Config.Redacted("OPENROUTER_API_KEY")).pipe(Effect.orDie)
      const generate = Effect.fn("ModelRunner.generate")(function*(request: GenerateRequest) {
        const started = Date.now()
        const fail = (message: string) => new ModelError({ model: request.model, message })
        const viaOpenRouter = request.model.startsWith(OPENROUTER)
        if (NATIVE_ONLY.test(request.model)) return yield* fail("Anthropic and OpenAI models run on omp's native providers, not OpenRouter")
        let key: Redacted.Redacted<string> | undefined
        if (viaOpenRouter) {
          const keyFile = (yield* settings.current).openRouterKeyFile
          key = keyFile !== undefined
            ? Redacted.make((yield* fs.readFileString(path.resolve(home.root, keyFile)).pipe(Effect.mapError(() => fail(`cannot read openRouterKeyFile ${keyFile}`)))).trim())
            : Option.getOrUndefined(keyEnv)
          if (key === undefined) return yield* fail(`openrouter models need openRouterKeyFile in ${settings.file} or OPENROUTER_API_KEY`)
        }
        const result = yield* Effect.scoped(Effect.gen(function*() {
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "atomic-agent-" })
          return yield* exec("omp", [
            "-p", "--mode", "json",
            "--model", request.model,
            "--thinking", request.thinking ?? "off",
            "--no-tools", "--no-skills", "--no-rules", "--no-extensions", "--no-lsp",
            "--no-session", "--no-title",
            "--system-prompt", request.system,
            ...(request.files ?? []).map((file) => `@${file}`),
            request.prompt
          ], { cwd, env: { OPENROUTER_API_KEY: key, OPENROUTER_API_KEY_FILE: undefined } })
        })).pipe(
          Effect.timeoutOrElse({
            duration: request.timeout ?? "5 minutes",
            orElse: () => Effect.fail(fail("timed out"))
          }),
          Effect.catchTag("PlatformError", (error) => Effect.fail(fail(error.message)))
        )
        // Provider errors (401, rate limits) arrive as an errored assistant message; omp may also exit non-zero.
        const reply = lastAssistant(result.stdout)
        if (reply?.message.stopReason === "error") return yield* fail(reply.message.errorMessage ?? "provider error")
        if (result.exitCode !== 0) return yield* fail(`omp exited ${result.exitCode}: ${(result.stderr || result.stdout).slice(-800)}`)
        if (reply === undefined) return yield* fail(`no assistant message: ${result.stderr.slice(-800)}`)
        const { message, cost } = reply
        if ((message.provider === "openrouter") !== viaOpenRouter) {
          return yield* fail(`served by ${message.provider}, expected ${viaOpenRouter ? "openrouter" : "a native provider"}`)
        }
        const text = message.content.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("")
        if (text.trim() === "") return yield* fail("empty reply")
        return { text, model: request.model, provider: message.provider, seconds: (Date.now() - started) / 1000, cost }
      }, Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      return ModelRunner.of({ generate })
    })
  )
}
