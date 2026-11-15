import { Config, Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { pack } from "../../Adapter.ts"
import { moduleFile } from "../../Component.ts"
import { exec } from "../../exec.ts"

export class BlenderError extends Schema.TaggedError<BlenderError>()("BlenderError", {
  message: Schema.String,
  log: Schema.String
}) {}

/** Run a geometry-only build() script, export the model as GLB, render it on the fixed stage (floor, three lights, auto-framed camera). */
export class Blender extends Context.Service<Blender, {
  render(script: string, image: string, glb: string): Effect.Effect<void, BlenderError>
}>()("atomic-agents/blender/Blender") {
  static readonly layer = Layer.effect(
    Blender,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const binary = yield* Config.String("BLENDER").pipe(Config.withDefault("blender"))
      const stage = yield* moduleFile(import.meta.url, "./stage.py")
      const render = Effect.fn("Blender.render")(function*(script: string, image: string, glb: string) {
        const result = yield* exec(binary, [
          "-b", "--factory-startup", "-noaudio", "--python-exit-code", "1",
          "--python", stage, "--", script, image, glb
        ]).pipe(
          Effect.timeoutOrElse({ duration: "3 minutes", orElse: () => Effect.fail(new BlenderError({ message: "render timed out", log: "" })) }),
          Effect.catchTag("PlatformError", (error) => Effect.fail(new BlenderError({ message: error.message, log: "" })))
        )
        if (result.exitCode !== 0) {
          const output = `${result.stdout}\n${result.stderr}`
          const marker = output.indexOf("STAGE_ERROR")
          const log = (marker >= 0 ? output.slice(marker + "STAGE_ERROR".length) : output).trim().slice(-2500)
          return yield* new BlenderError({ message: log.split("\n").at(-1) ?? "blender failed", log })
        }
      }, Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
      return Blender.of({ render })
    })
  )
}

export const blender = pack({
  name: "blender",
  layer: Blender.layer,
  checks: [{
    name: "blender.render",
    description:
      "The reply is a Blender Python build() script (fenced or bare); it must run in headless Blender on the stage. Provides image (768x768 PNG), glb (the bare model) and script, all in the run dir. A failing script goes back once with Blender's traceback; failing again fails the run.",
    provides: ["image", "glb", "script"],
    check: (reply, context) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const image = path.join(context.runDir, "render.png")
        const glb = path.join(context.runDir, "model.glb")
        const code = /```(?:python|py)?\n([\s\S]*?)```/.exec(reply.text)?.[1] ?? reply.text
        const script = path.join(context.runDir, `build-${context.attempt}.py`)
        yield* fs.writeFileString(script, code).pipe(
          Effect.mapError((error) => new BlenderError({ message: `write ${script}: ${error.message}`, log: "" }))
        )
        const outcome = yield* Effect.result((yield* Blender).render(script, image, glb))
        if (outcome._tag === "Success") return { pass: true as const, fields: { image, glb, script } }
        return {
          pass: false as const,
          // One repair turn: the agent sees its own script and Blender's traceback.
          repair: `${context.prompt}\n\nYour previous script failed in Blender:\n\`\`\`python\n${code}\n\`\`\`\nError:\n${outcome.failure.log}\n\nReturn the corrected script.`,
          giveUp: Effect.fail(outcome.failure)
        }
      })
  }]
})
