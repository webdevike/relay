import { Context, Duration, Effect, FileSystem, Layer, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { exec } from "./exec.ts"

export interface GenerateRequest {
  /** omp model id, e.g. "anthropic/claude-sonnet-5" (fuzzy names work too). The bake-off seam. */
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
  readonly seconds: number
}

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  model: Schema.String,
  message: Schema.String
}) {}

/**
 * One-shot model call for a component's agent. The omp implementation runs `omp -p` with no
 * tools, skills, rules, extensions or session, from an empty temp dir so no repo context
 * (AGENTS.md, Eva identity) leaks into a specialist's prompt. Auth and provider routing stay omp's.
 */
export class ModelRunner extends Context.Service<ModelRunner, {
  generate(request: GenerateRequest): Effect.Effect<Generation, ModelError>
}>()("atomic-agents/ModelRunner") {
  static readonly omp = Layer.effect(
    ModelRunner,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const generate = Effect.fn("ModelRunner.generate")(function*(request: GenerateRequest) {
        const started = Date.now()
        const fail = (message: string) => new ModelError({ model: request.model, message })
        const result = yield* Effect.scoped(Effect.gen(function*() {
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "atomic-agent-" })
          return yield* exec("omp", [
            "-p",
            "--model", request.model,
            "--thinking", request.thinking ?? "off",
            "--no-tools", "--no-skills", "--no-rules", "--no-extensions", "--no-lsp",
            "--no-session", "--no-title",
            "--system-prompt", request.system,
            ...(request.files ?? []).map((file) => `@${file}`),
            request.prompt
          ], { cwd })
        })).pipe(
          Effect.timeoutOrElse({
            duration: request.timeout ?? "5 minutes",
            orElse: () => Effect.fail(fail("timed out"))
          }),
          Effect.catchTag("PlatformError", (error) => Effect.fail(fail(error.message)))
        )
        if (result.exitCode !== 0) return yield* fail(`omp exited ${result.exitCode}: ${result.stderr.slice(-800)}`)
        if (result.stdout.trim() === "") return yield* fail("empty reply")
        return { text: result.stdout, model: request.model, seconds: (Date.now() - started) / 1000 }
      }, Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      return ModelRunner.of({ generate })
    })
  )
}
