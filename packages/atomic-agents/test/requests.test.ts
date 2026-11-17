import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, FileSystem, Layer, Schema } from "effect"
import { Background } from "../src/core/Background.ts"
import { define, job, Trigger } from "../src/core/Component.ts"
import { EventBus, makeEvent } from "../src/core/Event.ts"
import { ModelRunner } from "../src/core/Model.ts"
import { catalog, request, result, runs, SUMMARY_MAX, summaryOf } from "../src/core/Requests.ts"
import { Runner } from "../src/core/Runtime.ts"
import { publishRuntime } from "../src/core/RuntimeEvents.ts"
import { runtime, tempHome } from "./harness.ts"

/** An ask-pair agent spec: a question in, the model's JSON answer out. */
const researcher = {
  id: "researcher",
  purpose: "Answer one question.",
  agent: { model: "test/m", candidates: ["test/m"], system: "You answer." },
  events: {
    "question.asked": { requestId: "nonEmptyString", question: "nonEmptyString", "depth?": { enum: ["quick", "deep"] } },
    "question.answered": { requestId: "string", answer: "string", cost: "number", seconds: "number" }
  },
  job: {
    id: "answer",
    description: "Answer the question.",
    input: "question.asked",
    triggers: [{ onEvent: "question.asked" }, "manual"],
    prompt: "{{question}}",
    answer: { answer: "string" },
    output: "question.answered"
  },
  asks: { request: "question.asked", reply: "question.answered", show: "answer" }
}

/** A code agent without an ask pair: `request` reaches its manual job through `run.requested`. */
const tallyEvents = {
  "item.counted": Schema.Struct({ item: Schema.String }),
  "tally.completed": Schema.Struct({ items: Schema.Number, modelCalls: Schema.Number, cost: Schema.Number })
}
const tally = define({
  id: "tally",
  events: tallyEvents,
  purpose: "Count the items it is given.",
  agent: { model: "test/code", candidates: ["test/code"], system: "" },
  jobs: [job(tallyEvents, {
    id: "count",
    description: "Emit one item.counted per item, then the total.",
    input: Schema.Struct({ items: Schema.Array(Schema.String) }),
    triggers: [Trigger.Manual()],
    run: ({ items }, ctx) =>
      Effect.gen(function*() {
        for (const item of items) yield* ctx.emit("item.counted", { item })
        yield* ctx.emit("tally.completed", { items: items.length, modelCalls: 0, cost: 0.25 })
      })
  })],
  tools: Layer.empty
})

/**
 * A running service (triggers armed) over a temp home: `researcher` as an agent file, `tally` as code, `config`
 * as config.json. Every model call waits for `gate`, so a test can hold a run open.
 */
const service = (root: string, gate: Deferred.Deferred<void>) =>
  Runner.layerTriggers.pipe(
    Layer.provideMerge(Background.layer),
    Layer.provideMerge(runtime(root, { dirs: [`${root}/agents`], code: [tally] }, ModelRunner.of({
      generate: (asked) =>
        Deferred.await(gate).pipe(Effect.as({ text: JSON.stringify({ answer: { answer: `about ${asked.prompt}` } }), model: asked.model, provider: "test", seconds: 0, cost: 0.002 }))
    })))
  )

const home = (config: unknown = {}) =>
  Effect.gen(function*() {
    const root = yield* tempHome
    yield* Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${root}/agents`, { recursive: true })
      yield* fs.writeFileString(`${root}/agents/researcher.json`, JSON.stringify(researcher))
      yield* fs.writeFileString(`${root}/config.json`, JSON.stringify(config))
    }).pipe(Effect.provide(BunServices.layer))
    return root
  })

describe("asking agents from outside the service", () => {
  test("the catalog lists every enabled agent with its request schema (without requestId), reply shape, model and typical run", () =>
    Effect.gen(function*() {
      const root = yield* home({ components: { tally: { enabled: false } } })
      const gate = yield* Deferred.make<void>()
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.gen(function*() {
        const before = yield* catalog
        expect(before.map((entry) => [entry.id, entry.how, entry.job, entry.required])).toEqual([["researcher", "ask", "answer", ["question"]]])
        const [asked] = before
        expect(Object.keys(asked!.request["properties"] as object)).toEqual(["question", "depth"])
        expect(Object.keys(asked!.reply["properties"] as object)).toEqual(["answer", "cost", "seconds"])
        expect([asked!.model, asked!.typical]).toEqual(["test/m", { runs: 0 }])

        yield* request("researcher", { question: "tides" }, 10_000)
        const [after] = yield* catalog
        expect(after!.typical.runs).toBe(1)
        expect(after!.typical.cost).toBe(0.002)
      }).pipe(Effect.provide(service(root, gate)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)

  test("a long ask comes back running with its run id; result waits for the typed reply", () =>
    Effect.gen(function*() {
      const root = yield* home()
      const gate = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const first = yield* request("researcher", { question: "tides", depth: "quick" }, 300)
        expect(first).toMatchObject({ agent: "researcher", status: "running", request: { question: "tides", depth: "quick" } })
        expect(first.reply).toBeUndefined()
        expect((yield* result(first.run, 0)).status).toBe("running")

        yield* Deferred.succeed(gate, undefined)
        const done = yield* result(first.run, 10_000)
        expect(done).toMatchObject({ run: first.run, agent: "researcher", status: "done", text: "about tides", model: "test/m", cost: 0.002 })
        expect(done.reply).toMatchObject({ answer: "about tides", cost: 0.002 })
        expect(done.reply).not.toHaveProperty("requestId")
        expect(typeof done.seconds).toBe("number")
      }).pipe(Effect.provide(service(root, gate)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)

  test("an agent without an ask pair runs its job on request; the reply is every event the run emitted", () =>
    Effect.gen(function*() {
      const root = yield* home()
      const gate = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const done = yield* request("tally", { items: ["a", "b"] }, 10_000)
        expect(done).toMatchObject({ agent: "tally", status: "done", request: { items: ["a", "b"] }, cost: 0.25 })
        expect(done.reply).toEqual({
          events: [
            { type: "item.counted", data: { item: "a" } },
            { type: "item.counted", data: { item: "b" } },
            { type: "tally.completed", data: { items: 2, modelCalls: 0, cost: 0.25 } }
          ]
        })
      }).pipe(Effect.provide(service(root, gate)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)

  test("refusals: a request its schema rejects (with the schema, nothing sent), an unknown or disabled agent, an unknown run, a run the service cannot start", () =>
    Effect.gen(function*() {
      const root = yield* home({ components: { tally: { enabled: false } } })
      const gate = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const bus = yield* EventBus
        const invalid = yield* request("researcher", { depth: "deep" }, 0).pipe(Effect.flip)
        expect(invalid._tag).toBe("RequestError")
        expect(invalid.message).toContain("researcher rejects this request")
        expect(invalid).toMatchObject({ schema: { required: ["question"] } })
        expect((yield* bus.history).filter((event) => event.type === "researcher/question.asked")).toEqual([])

        expect((yield* request("nobody", {}, 0).pipe(Effect.flip)).message).toBe("no agent nobody (have: researcher)")
        expect((yield* request("tally", { items: [] }, 0).pipe(Effect.flip)).message).toContain("tally is disabled")
        expect((yield* result("no-such-run", 0).pipe(Effect.flip))._tag).toBe("UnknownRun")

        // Sent, but the service refuses it (the agent changed in between): the run fails with the reason.
        yield* publishRuntime(bus, "run.requested", { requestId: "r-gone", agent: "researcher", job: "nope", input: {} }, "test")
        expect(yield* result("r-gone", 10_000)).toMatchObject({ run: "r-gone", agent: "researcher", status: "failed", error: "no job researcher/nope" })
      }).pipe(Effect.provide(service(root, gate)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)

  test("runs: the newest runs with who asked and the request on one line, and each agent's calls, cost and callers", () =>
    Effect.gen(function*() {
      const root = yield* home()
      const gate = yield* Deferred.make<void>()
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.gen(function*() {
        const bus = yield* EventBus
        const first = yield* request("researcher", { question: "tides\n  and moons" }, 10_000, "agent:nova")
        const second = yield* request("tally", { items: ["a"] }, 10_000, "agent:astra")
        const third = yield* request("researcher", { question: "winds" }, 10_000)
        expect([first.caller, second.caller, third.caller]).toEqual(["agent:nova", "agent:astra", undefined])
        expect((yield* result(first.run, 0)).caller).toBe("agent:nova")
        // The caller rides on the request's envelope, never in the agent's own data.
        const asked = (yield* bus.history).find((event) => event.type === "researcher/question.asked" && event.caller === "agent:nova")
        expect(asked?.data).not.toHaveProperty("caller")
        // A consumer's own ask on the bus (the Relay Host's widget asks run as `relay-...`) is not a specialist call.
        yield* bus.publish(yield* makeEvent({ type: "researcher/question.asked", component: "researcher", job: "ask", run: "relay-1", data: { requestId: "host-1", question: "q" } }))

        const report = yield* runs({ days: 7, limit: 3 })
        expect(report.runs.map((run) => [run.run, run.agent, run.caller, run.summary, run.status])).toEqual([
          [third.run, "researcher", undefined, "winds", "done"],
          [second.run, "tally", "agent:astra", '{"items":["a"]}', "done"],
          [first.run, "researcher", "agent:nova", "tides and moons", "done"]
        ])
        expect(report.runs[2]).toMatchObject({ model: "test/m", cost: 0.002 })
        expect(report.runs[2]).not.toHaveProperty("request")
        expect(report.runs[2]).not.toHaveProperty("reply")
        expect(report.agents).toEqual([
          { agent: "researcher", calls: 2, failed: 0, cost: 0.004, callers: [{ caller: "agent:nova", calls: 1 }, { calls: 1 }] },
          { agent: "tally", calls: 1, failed: 0, cost: 0.25, callers: [{ caller: "agent:astra", calls: 1 }] }
        ])
        expect((yield* runs({ days: 7, limit: 1 })).runs.map((run) => run.run)).toEqual([third.run])
        expect((yield* runs({ days: 7, limit: 10, agent: "tally" })).runs.map((run) => run.run)).toEqual([second.run])
        expect((yield* runs({ days: 0, limit: 0 }))).toMatchObject({ runs: [], agents: [] })
        expect(summaryOf({ question: "x".repeat(400) })).toHaveLength(SUMMARY_MAX)
      }).pipe(Effect.provide(service(root, gate)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)
})
