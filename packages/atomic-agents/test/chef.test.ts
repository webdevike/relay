import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Option, Ref, Schedule, Schema } from "effect"
import { Background } from "../src/Background.ts"
import { Chefs, parseChef } from "../src/Chef.ts"
import { EventBus, makeEvent } from "../src/Event.ts"
import { ModelRunner } from "../src/Model.ts"
import { Runner } from "../src/Runtime.ts"
import { oneProcess, runtime, tempHome } from "./harness.ts"

/** A recipe chef: a request in, the model's JSON answer out. */
const recipe = (prompt: string) => ({
  id: "greeter",
  purpose: "Greet whoever is named.",
  agent: { model: "test/m", candidates: ["test/m"], system: "You greet people." },
  events: {
    "greet.requested": { requestId: "nonEmptyString", name: "string" },
    "greet.ready": { requestId: "string", greeting: "string" }
  },
  job: {
    id: "greet",
    description: "Greet the name.",
    input: "greet.requested",
    triggers: [{ onEvent: "greet.requested" }, "manual"],
    prompt,
    answer: { greeting: "string" },
    output: "greet.ready"
  }
})

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** Why a chef file would not load, as `config.rejected` and `chef validate` say it. */
const rejection = (root: string, file: string, value: unknown) =>
  parseChef(`${root}/${file}`, typeof value === "string" ? value : json(value)).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
    Effect.provide(oneProcess(root))
  )

describe("chef file validation", () => {
  test("an unknown adapter is a load error naming it and the ones that exist", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const base = recipe("{{name}}")
      const message = yield* rejection(root, "greeter.json", { ...base, job: { ...base.job, check: "openui.parze", tools: ["gmail.archive"] } })
      expect(message).toContain(`unknown check adapter "openui.parze" (have: openui.parse, blender.render)`)
      expect(message).toContain(`unknown tool adapter "gmail.archive" (have: gmail.read_thread, gmail.sender_history)`)
    }).pipe(Effect.scoped, Effect.runPromise))

  test("the recipe's fields are checked end to end: prompt fields, output fields, events, triggers, types", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const base = recipe("Hello {{nam}}")
      const message = yield* rejection(root, "greeter.json", {
        ...base,
        events: { ...base.events, "greet.ready": { requestId: "string", greeting: "string", mood: "strng" } },
        job: { ...base.job, triggers: [{ onEvent: "greet.asked" }, { cron: "every day" }], answer: { greet: "string" } }
      })
      expect(message).toContain("events.greet.ready.mood: unknown type \"strng\"")
      expect(message).toContain("job.triggers[0]: \"greet.asked\" is not a declared event")
      expect(message).toContain("job.triggers[1]: bad cron \"every day\"")
      expect(message).toContain("job.prompt: {{nam}} is not an input, source or step field (have: requestId, name)")
    }).pipe(Effect.scoped, Effect.runPromise))

  test("schema errors, unknown keys and a file named for another id are rejected before anything compiles", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const { purpose: _, ...noPurpose } = recipe("{{name}}")
      expect(yield* rejection(root, "greeter.json", noPurpose)).toContain("purpose")
      expect(yield* rejection(root, "greeter.json", { ...recipe("{{name}}"), color: "blue" })).toContain("color")
      expect(yield* rejection(root, "other.json", recipe("{{name}}"))).toContain("id greeter must match the file name (other)")
      expect(yield* rejection(root, "greeter.yaml", "id: greeter\npurpose: [")).toContain("not valid YAML")
    }).pipe(Effect.scoped, Effect.runPromise))
})

describe("escape hatch", () => {
  test("a kind: code chef loads the define()d component its module exports and runs it; a bad export is a load error", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const fixture = new URL("./fixtures/echo.ts", import.meta.url).pathname
      const chefs = `${root}/chefs`
      yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(chefs)
        yield* fs.writeFileString(`${chefs}/echo.json`, json({ id: "echo", kind: "code", module: fixture, export: "echo" }))
      }).pipe(Effect.provide(BunServices.layer))
      yield* Effect.gen(function*() {
        const loaded = (yield* (yield* Chefs).current).find((chef) => chef.id === "echo")
        expect([loaded?.kind, loaded?.file]).toEqual(["code", `${chefs}/echo.json`])
        const result = yield* (yield* Runner).run("echo", "say", { text: "hi" })
        const done = (yield* (yield* EventBus).history).find((event) => event.run === result.run && event.type === "echo/echo.done")
        expect(done?.data).toEqual({ said: "hi" })
      }).pipe(Effect.provide(runtime(root, { dirs: [chefs] })))

      expect(yield* rejection(root, "echo.json", { id: "echo", kind: "code", module: fixture, export: "nope" })).toContain("exports no define()d component as nope (exports: echo)")
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)
})

const eventually = <A, E>(check: Effect.Effect<Option.Option<A>, E>) =>
  check.pipe(
    Effect.flatMap((found) => Option.isSome(found) ? Effect.succeed(found.value) : Effect.fail("not yet" as const)),
    Effect.retry(Schedule.spaced("100 millis")),
    Effect.timeout("10 seconds")
  )

describe("hot reload", () => {
  test("a chef file written, edited, broken and deleted under a running service: loaded and armed, replaced, last good kept, removed", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const chefs = `${root}/chefs`
      const file = `${chefs}/greeter.json`
      const prompts = yield* Ref.make<ReadonlyArray<string>>([])
      const models = ModelRunner.of({
        generate: (request) =>
          Ref.update(prompts, (seen) => [...seen, request.prompt]).pipe(
            Effect.as({ text: JSON.stringify({ answer: { greeting: "hello" } }), model: request.model, provider: "test", seconds: 0, cost: 0 })
          )
      })
      const Ready = Schema.Struct({ requestId: Schema.String, greeting: Schema.String })
      yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const bus = yield* EventBus
        const runner = yield* Runner
        const latest = (type: string) => Effect.map(bus.history, (events) => Option.fromUndefinedOr(events.filter((event) => event.type === type).at(-1)))
        const count = (type: string) => Effect.map(bus.history, (events) => events.filter((event) => event.type === type).length)

        // Written while the service runs: loaded, and its OnEvent trigger answers without a restart.
        yield* fs.makeDirectory(chefs)
        yield* fs.writeFileString(file, json(recipe("Greet {{name}}")))
        expect((yield* eventually(latest("atomic-agents/chef.loaded"))).data).toEqual({ id: "greeter", file, kind: "recipe", replaced: false })
        yield* bus.publish(yield* makeEvent({ type: "greeter/greet.requested", component: "test", job: "t", run: "t1", data: { requestId: "r1", name: "Ada" } }))
        const ready = yield* eventually(latest("greeter/greet.ready"))
        expect(yield* Schema.decodeUnknownEffect(Ready)(ready.data)).toEqual({ requestId: "r1", greeting: "hello" })
        expect(yield* Ref.get(prompts)).toEqual(["Greet Ada"])

        // Edited: the new version replaces the old one for the next run.
        yield* fs.writeFileString(file, json(recipe("Say hello to {{name}}")))
        yield* eventually(Effect.map(count("atomic-agents/chef.loaded"), (n) => Option.liftPredicate(n, (loaded) => loaded === 2)))
        expect((yield* latest("atomic-agents/chef.loaded")).pipe(Option.map((event) => event.data))).toEqual(Option.some({ id: "greeter", file, kind: "recipe", replaced: true }))
        yield* runner.run("greeter", "greet", { requestId: "r2", name: "Bo" })
        expect((yield* Ref.get(prompts)).at(-1)).toBe("Say hello to Bo")

        // Broken: rejected with the reason, and the last good version keeps running.
        yield* fs.writeFileString(file, json({ ...recipe("{{name}}"), job: { ...recipe("{{name}}").job, check: "nope" } }))
        const rejected = yield* eventually(latest("atomic-agents/config.rejected"))
        const { error } = yield* Schema.decodeUnknownEffect(Schema.Struct({ error: Schema.String }))(rejected.data)
        expect(error).toContain(`${file}: unknown check adapter "nope"`)
        yield* runner.run("greeter", "greet", { requestId: "r3", name: "Cy" })
        expect((yield* Ref.get(prompts)).at(-1)).toBe("Say hello to Cy")

        // Deleted: removed, and a run is an unknown job.
        yield* fs.remove(file)
        expect((yield* eventually(latest("atomic-agents/chef.removed"))).data).toEqual({ id: "greeter", file })
        const gone = yield* runner.run("greeter", "greet", { requestId: "r4", name: "Di" }).pipe(Effect.flip)
        expect(gone._tag).toBe("UnknownJob")
      }).pipe(Effect.provide(Layer.mergeAll(Chefs.layerWatch, Runner.layerTriggers).pipe(
        Layer.provideMerge(Background.layer),
        Layer.provideMerge(runtime(root, { dirs: [chefs] }, models))
      )))
    }).pipe(Effect.scoped, Effect.runPromise), 30_000)
})
