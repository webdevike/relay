import { Config, Context, DateTime, Effect, FileSystem, Layer, Path, Result, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { Cron, define, job, Manual, OnEvent } from "../../Component.ts"
import { exec } from "../../exec.ts"
import { ModelRunner } from "../../Model.ts"

const knowledge = await Bun.file(new URL("./knowledge.md", import.meta.url)).text()
const STAGE = new URL("./stage.py", import.meta.url).pathname

/** Output contract. `render.requested` is the inbound request other agents emit. */
const events = {
  "render.requested": Schema.Struct({ subject: Schema.NonEmptyString }),
  "render.completed": Schema.Struct({
    subject: Schema.String,
    model: Schema.String,
    /** Absolute path of the 768x768 PNG. */
    image: Schema.String,
    /** The build() script that produced it, for reruns and review. */
    script: Schema.String,
    attempts: Schema.Int,
    seconds: Schema.Number
  })
}

export class BlenderError extends Schema.TaggedError<BlenderError>()("BlenderError", {
  message: Schema.String,
  log: Schema.String
}) {}

/** Tool: render a geometry-only build() script on the fixed stage (floor, three lights, auto-framed camera). */
export class Blender extends Context.Service<Blender, {
  render(script: string, image: string): Effect.Effect<void, BlenderError>
}>()("atomic-agents/prop-render/Blender") {
  static readonly layer = Layer.effect(
    Blender,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const binary = yield* Config.String("BLENDER").pipe(Config.withDefault("blender"), Effect.orDie)
      const render = Effect.fn("Blender.render")(function*(script: string, image: string) {
        const result = yield* exec(binary, [
          "-b", "--factory-startup", "-noaudio", "--python-exit-code", "1",
          "--python", STAGE, "--", script, image
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

/** Daily subjects for the morning job; the bench reuses them as cases. */
export const SUBJECTS = [
  "a brass desk lamp with an articulated arm",
  "a ceramic coffee mug with a chipped rim",
  "a vintage rotary telephone",
  "a potted succulent in a terracotta pot",
  "a wooden chess rook",
  "a retro robot toy",
  "a glass perfume bottle with a gold cap"
] as const

const MAX_ATTEMPTS = 2

const render = job(events, {
  id: "render",
  description: "Model one object as a Blender script, render it on the stage, emit render.completed.",
  input: Schema.Struct({ subject: Schema.NonEmptyString }),
  triggers: [
    Manual,
    OnEvent("prop-render/render.requested"),
    Cron("0 9 * * *", Effect.map(DateTime.now, (now) => ({
      subject: SUBJECTS[Math.floor(DateTime.toEpochMillis(now) / 86_400_000) % SUBJECTS.length]
    })))
  ],
  run: Effect.fnUntraced(function*({ subject }, ctx) {
    const models = yield* ModelRunner
    const blender = yield* Blender
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const image = path.join(ctx.runDir, "render.png")
    const started = Date.now()
    let prompt = `Model this object: ${subject}`
    for (let attempt = 1; ; attempt++) {
      const reply = yield* models.generate({
        model: ctx.model,
        system: ctx.agent.system,
        prompt,
        ...(ctx.agent.thinking ? { thinking: ctx.agent.thinking } : {})
      })
      const code = /```(?:python|py)?\n([\s\S]*?)```/.exec(reply.text)?.[1] ?? reply.text
      const script = path.join(ctx.runDir, `build-${attempt}.py`)
      yield* fs.writeFileString(script, code).pipe(Effect.orDie)
      const outcome = yield* Effect.result(blender.render(script, image))
      if (Result.isSuccess(outcome)) {
        return yield* ctx.emit("render.completed", {
          subject,
          model: ctx.model,
          image,
          script,
          attempts: attempt,
          seconds: (Date.now() - started) / 1000
        })
      }
      if (attempt === MAX_ATTEMPTS) return yield* outcome.failure
      // One repair turn: the agent sees its own script and Blender's traceback.
      prompt = `Model this object: ${subject}\n\nYour previous script failed in Blender:\n\`\`\`python\n${code}\n\`\`\`\nError:\n${outcome.failure.log}\n\nReturn the corrected script.`
    }
  })
})

export const propRender = define({
  id: "prop-render",
  purpose: "Turn a one-line object description into a studio render of a 3D model built in Blender.",
  agent: {
    model: "anthropic/claude-sonnet-5-5",
    candidates: [
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-opus-5-5",
      "openai-codex/gpt-6-astra",
      "openai-codex/gpt-6.1-sol"
    ],
    thinking: "low",
    system: `You are a 3D prop modeller. You write one Blender Python script that builds a single object from primitives, modifiers and materials.\n\n${knowledge}`
  },
  events,
  jobs: [render],
  tools: Blender.layer
})
