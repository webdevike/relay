import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Option, Ref, Schedule, Schema } from "effect"
import { Background } from "../src/core/Background.ts"
import { Agents, parseAgent } from "../src/core/Agent.ts"
import { EventBus, makeEvent } from "../src/core/Event.ts"
import { ModelRunner } from "../src/core/Model.ts"
import { Runner } from "../src/core/Runtime.ts"
import { oneProcess, runtime, tempHome } from "./harness.ts"

/** A spec agent: a request in, the model's JSON answer out. */
const spec = (prompt: string) => ({
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

/** Why an agent file would not load, as `config.rejected` and `agent validate` say it. */
const rejection = (root: string, file: string, value: unknown) =>
  parseAgent(`${root}/${file}`, typeof value === "string" ? value : json(value)).pipe(
    Effect.flip,
    Effect.map((error) => error.message),
    Effect.provide(oneProcess(root))
  )

describe("agent file validation", () => {
  test("an unknown adapter is a load error naming it and the ones that exist", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const base = spec("{{name}}")
      const message = yield* rejection(root, "greeter.json", { ...base, job: { ...base.job, check: "openui.parze", tools: ["gmail.archive"] } })
      expect(message).toContain(`unknown check adapter "openui.parze" (have: openui.parse, blender.render,`)
      expect(message).toContain(`unknown tool adapter "gmail.archive" (have: gmail.read_thread, gmail.sender_history, ecard.linear_issue,`)
    }).pipe(Effect.scoped, Effect.runPromise))

  test("the agent spec's fields are checked end to end: prompt fields, output fields, events, triggers, types", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const base = spec("Hello {{nam}}")
      const message = yield* rejection(root, "greeter.json", {
        ...base,
        events: { ...base.events, "greet.ready": { requestId: "string", greeting: "string", mood: "strng" } },
        job: { ...base.job, triggers: [{ onEvent: "greet.asked" }, { cron: "every day" }], answer: { greet: "string" }, attach: ["shots"] }
      })
      expect(message).toContain("events.greet.ready.mood: unknown type \"strng\"")
      expect(message).toContain("job.triggers[0]: \"greet.asked\" is not a declared event")
      expect(message).toContain("job.triggers[1]: bad cron \"every day\"")
      expect(message).toContain("job.prompt: {{nam}} is not an input, source or step field (have: requestId, name)")
      expect(message).toContain("job.attach: shots is not an input, source or step field (have: requestId, name)")
    }).pipe(Effect.scoped, Effect.runPromise))

  test("schema errors, unknown keys and a file named for another id are rejected before anything compiles", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const { purpose: _, ...noPurpose } = spec("{{name}}")
      expect(yield* rejection(root, "greeter.json", noPurpose)).toContain("purpose")
      expect(yield* rejection(root, "greeter.json", { ...spec("{{name}}"), color: "blue" })).toContain("color")
      expect(yield* rejection(root, "other.json", spec("{{name}}"))).toContain("id greeter must match the file name (other)")
      expect(yield* rejection(root, "greeter.yaml", "id: greeter\npurpose: [")).toContain("not valid YAML")
    }).pipe(Effect.scoped, Effect.runPromise))
})

describe("escape hatch", () => {
  test("a kind: code agent loads the define()d component its module exports and runs it; a bad export is a load error", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const fixture = new URL("./fixtures/echo.ts", import.meta.url).pathname
      const agents = `${root}/agents`
      yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(agents)
        yield* fs.writeFileString(`${agents}/echo.json`, json({ id: "echo", kind: "code", module: fixture, export: "echo" }))
      }).pipe(Effect.provide(BunServices.layer))
      yield* Effect.gen(function*() {
        const loaded = (yield* (yield* Agents).current).find((agent) => agent.id === "echo")
        expect([loaded?.kind, loaded?.file]).toEqual(["code", `${agents}/echo.json`])
        const result = yield* (yield* Runner).run("echo", "say", { text: "hi" })
        const done = (yield* (yield* EventBus).history).find((event) => event.run === result.run && event.type === "echo/echo.done")
        expect(done?.data).toEqual({ said: "hi" })
      }).pipe(Effect.provide(runtime(root, { dirs: [agents] })))

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
  test("an agent file written, edited, broken and deleted under a running service: loaded and armed, replaced, last good kept, removed", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const agents = `${root}/agents`
      const file = `${agents}/greeter.json`
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
        yield* fs.makeDirectory(agents)
        yield* fs.writeFileString(file, json(spec("Greet {{name}}")))
        expect((yield* eventually(latest("atomic-agents/agent.loaded"))).data).toEqual({ id: "greeter", file, kind: "spec", replaced: false })
        yield* bus.publish(yield* makeEvent({ type: "greeter/greet.requested", component: "test", job: "t", run: "t1", data: { requestId: "r1", name: "Ada" } }))
        const ready = yield* eventually(latest("greeter/greet.ready"))
        expect(yield* Schema.decodeUnknownEffect(Ready)(ready.data)).toEqual({ requestId: "r1", greeting: "hello" })
        expect(yield* Ref.get(prompts)).toEqual(["Greet Ada"])

        // Edited: the new version replaces the old one for the next run.
        yield* fs.writeFileString(file, json(spec("Say hello to {{name}}")))
        yield* eventually(Effect.map(count("atomic-agents/agent.loaded"), (n) => Option.liftPredicate(n, (loaded) => loaded === 2)))
        expect((yield* latest("atomic-agents/agent.loaded")).pipe(Option.map((event) => event.data))).toEqual(Option.some({ id: "greeter", file, kind: "spec", replaced: true }))
        yield* runner.run("greeter", "greet", { requestId: "r2", name: "Bo" })
        expect((yield* Ref.get(prompts)).at(-1)).toBe("Say hello to Bo")

        // Broken: rejected with the reason, and the last good version keeps running.
        yield* fs.writeFileString(file, json({ ...spec("{{name}}"), job: { ...spec("{{name}}").job, check: "nope" } }))
        const rejected = yield* eventually(latest("atomic-agents/config.rejected"))
        const { error } = yield* Schema.decodeUnknownEffect(Schema.Struct({ error: Schema.String }))(rejected.data)
        expect(error).toContain(`${file}: unknown check adapter "nope"`)
        yield* runner.run("greeter", "greet", { requestId: "r3", name: "Cy" })
        expect((yield* Ref.get(prompts)).at(-1)).toBe("Say hello to Cy")

        // Deleted: removed, and a run is an unknown job.
        yield* fs.remove(file)
        expect((yield* eventually(latest("atomic-agents/agent.removed"))).data).toEqual({ id: "greeter", file })
        const gone = yield* runner.run("greeter", "greet", { requestId: "r4", name: "Di" }).pipe(Effect.flip)
        expect(gone._tag).toBe("UnknownJob")
      }).pipe(Effect.provide(Layer.mergeAll(Agents.layerWatch, Runner.layerTriggers).pipe(
        Layer.provideMerge(Background.layer),
        Layer.provideMerge(runtime(root, { dirs: [agents] }, models))
      )))
    }).pipe(Effect.scoped, Effect.runPromise), 30_000)
})
