import { Clock, Config, Context, DateTime, Effect, FileSystem, Layer, Path, PlatformError, Result, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { define, job, OnEvent, Trigger } from "../../Component.ts"
import { exec } from "../../exec.ts"
import { ModelRunner } from "../../Model.ts"

/** A file next to this module, as a path. */
const sibling = (name: string) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    return yield* path.fromFileUrl(new URL(name, import.meta.url)).pipe(Effect.mapError((reason) => new PlatformError.PlatformError(reason)))
  })

/** Output contract. `render.requested` is the inbound request other agents emit. */
const events = {
  "render.requested": Schema.Struct({ subject: Schema.NonEmptyString }),
  "render.completed": Schema.Struct({
    subject: Schema.String,
    model: Schema.String,
    /** Absolute path of the 768x768 PNG. */
    image: Schema.String,
    /** Absolute path of the bare model as GLB (modifiers applied; no floor, lights or camera), next to the PNG. */
    glb: Schema.String,
    /** The build() script that produced it, for reruns and review. */
    script: Schema.String,
    attempts: Schema.Int,
    seconds: Schema.Number,
    /** USD over all attempts, as omp prices them. */
    cost: Schema.Number
  })
}

const contract = { id: "prop-render" as const, events }

export class BlenderError extends Schema.TaggedError<BlenderError>()("BlenderError", {
  message: Schema.String,
  log: Schema.String
}) {}

/** Tool: run a geometry-only build() script, export the model as GLB, render it on the fixed stage (floor, three lights, auto-framed camera). */
export class Blender extends Context.Service<Blender, {
  render(script: string, image: string, glb: string): Effect.Effect<void, BlenderError>
}>()("atomic-agents/prop-render/Blender") {
  static readonly layer = Layer.effect(
    Blender,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const binary = yield* Config.String("BLENDER").pipe(Config.withDefault("blender"))
      const stage = yield* sibling("./stage.py")
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

/** The modelling knowledge (knowledge.md), read once when the runtime builds the tools; appended to the system prompt. */
export class Knowledge extends Context.Service<Knowledge, string>()("atomic-agents/prop-render/Knowledge") {
  static readonly layer = Layer.effect(
    Knowledge,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      return yield* fs.readFileString(yield* sibling("./knowledge.md"))
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
    Trigger.Manual(),
    OnEvent(contract, "render.requested"),
    Trigger.Cron({
      cron: "0 9 * * *",
      input: Effect.map(DateTime.now, (now) => ({
        subject: SUBJECTS[Math.floor(DateTime.toEpochMillis(now) / 86_400_000) % SUBJECTS.length]
      }))
    })
  ],
  run: Effect.fnUntraced(function*({ subject }, ctx) {
    const models = yield* ModelRunner
    const blender = yield* Blender
    const knowledge = yield* Knowledge
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const image = path.join(ctx.runDir, "render.png")
    const glb = path.join(ctx.runDir, "model.glb")
    const started = yield* Clock.currentTimeMillis
    let cost = 0
    let prompt = `Model this object: ${subject}`
    for (let attempt = 1; ; attempt++) {
      const reply = yield* models.generate({
        model: ctx.model,
        system: `${ctx.agent.system}\n\n${knowledge}`,
        prompt,
        ...(ctx.agent.thinking ? { thinking: ctx.agent.thinking } : {})
      })
      cost += reply.cost
      const code = /```(?:python|py)?\n([\s\S]*?)```/.exec(reply.text)?.[1] ?? reply.text
      const script = path.join(ctx.runDir, `build-${attempt}.py`)
      yield* fs.writeFileString(script, code).pipe(
        Effect.mapError((error) => new BlenderError({ message: `write ${script}: ${error.message}`, log: "" }))
      )
      const outcome = yield* Effect.result(blender.render(script, image, glb))
      if (Result.isSuccess(outcome)) {
        return yield* ctx.emit("render.completed", {
          subject,
          model: ctx.model,
          image,
          glb,
          script,
          attempts: attempt,
          seconds: ((yield* Clock.currentTimeMillis) - started) / 1000,
          cost
        })
      }
      if (attempt === MAX_ATTEMPTS) return yield* outcome.failure
      // One repair turn: the agent sees its own script and Blender's traceback.
      prompt = `Model this object: ${subject}\n\nYour previous script failed in Blender:\n\`\`\`python\n${code}\n\`\`\`\nError:\n${outcome.failure.log}\n\nReturn the corrected script.`
    }
  })
})

export const propRender = define({
  ...contract,
  purpose: "Turn a one-line object description into a studio render of a 3D model built in Blender.",
  agent: {
    model: "openrouter/moonshotai/kimi-k3.1-pro",
    candidates: [
      "openrouter/moonshotai/kimi-k3.1-pro",
      "openai-codex/gpt-6-sol",
      "openrouter/google/gemini-4-carbon",
      "openai-codex/gpt-6-astra",
      "anthropic/claude-opus-5-5"
    ],
    thinking: "low",
    system: "You are a 3D prop modeller. You write one Blender Python script that builds a single object from primitives, modifiers and materials."
  },
  jobs: [render],
  tools: Layer.mergeAll(Blender.layer, Knowledge.layer)
})
