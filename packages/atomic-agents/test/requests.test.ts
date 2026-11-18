import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, FileSystem, Layer, Schema } from "effect"
import { Agents } from "../src/core/Agent.ts"
import { Background } from "../src/core/Background.ts"
import { define, job, Trigger } from "../src/core/Component.ts"
import { AgentEvent, EventBus, makeEvent } from "../src/core/Event.ts"
import { ModelRunner } from "../src/core/Model.ts"
import { catalog, request, result, roster, runs, SUMMARY_MAX, summaryOf } from "../src/core/Requests.ts"
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

describe("the Relay Agents page's data", () => {
  test("the roster lists every agent in load order, disabled ones and files that fail to load too, with settings, knowledge and run stats", () =>
    Effect.gen(function*() {
      const root = yield* home({ components: { tally: { enabled: false, mode: "live", fallbackModel: "test/backup" }, broken: { mode: "off" } } })
      yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(`${root}/agents/notes`)
        yield* fs.writeFileString(`${root}/agents/notes/style.md`, "Be brief.")
        yield* fs.writeFileString(`${root}/agents/researcher.json`, JSON.stringify({ ...researcher, agent: { ...researcher.agent, knowledge: [{ file: "notes/style.md" }] } }))
        yield* fs.writeFileString(`${root}/agents/broken.json`, JSON.stringify({ id: "broken", purpose: "No job." }))
      }).pipe(Effect.provide(BunServices.layer))
      const gate = yield* Deferred.make<void>()
      yield* Effect.gen(function*() {
        const bus = yield* EventBus
        const now = Date.now()
        const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString()
        let seq = 0
        const seed = (run: string, name: string, minutes: number, data: Record<string, unknown>) =>
          bus.publish(new AgentEvent({ id: `seed-${seq++}`, type: `tally/${name}`, component: "tally", job: "count", run, at: ago(minutes), data }))
        // A cron-style run that succeeded, one that failed, one still running, one left unfinished long ago, one older than a week.
        yield* seed("cron-1", "job.started", 120, { input: {}, model: "test/code" })
        yield* seed("cron-1", "job.succeeded", 119, { model: "test/code", seconds: 60 })
        yield* seed("cron-2", "job.started", 180, { input: {}, model: "test/code" })
        yield* seed("cron-2", "job.failed", 179, { model: "test/code", seconds: 60, error: "Boom", message: "boom" })
        yield* seed("manual-1", "job.started", 10, { input: { items: [] }, model: "test/code" })
        yield* seed("manual-2", "job.started", 240, { input: {}, model: "test/code" })
        yield* seed("old-1", "job.started", 10 * 24 * 60, { input: {}, model: "test/code" })
        yield* seed("old-1", "job.succeeded", 10 * 24 * 60 - 1, { model: "test/code", seconds: 60 })

        const none = { week: 0, failed: 0, running: 0 }
        const entries = yield* roster
        expect(entries.map((entry) => entry.id)).toEqual(["tally", "researcher", "broken"])
        const [tallyEntry, researcherEntry, brokenEntry] = entries
        expect(tallyEntry).toEqual({
          id: "tally",
          purpose: "Count the items it is given.",
          kind: "code",
          knowledge: [],
          enabled: false,
          mode: "live",
          model: "test/code",
          fallbackModel: "test/backup",
          candidates: ["test/code"],
          how: "run",
          job: "count",
          trial: { on: false, arms: ["test/code"] },
          runs: { week: 4, failed: 1, running: 1, lastAt: ago(10) }
        })
        expect(researcherEntry).toEqual({
          id: "researcher",
          purpose: "Answer one question.",
          kind: "spec",
          file: `${root}/agents/researcher.json`,
          knowledge: [`${root}/agents/notes/style.md`],
          enabled: true,
          model: "test/m",
          candidates: ["test/m"],
          how: "ask",
          job: "answer",
          trial: { on: false, arms: ["test/m"] },
          runs: none
        })
        expect(brokenEntry).toMatchObject({ id: "broken", purpose: "", kind: "spec", file: `${root}/agents/broken.json`, knowledge: [], enabled: true, mode: "off", model: "", candidates: [], trial: { on: false, arms: [] }, runs: none })
        expect(brokenEntry!.error).toStartWith(`${root}/agents/broken.json: `)

        // A bad edit keeps the last good version in force; its entry says why the file does not load.
        yield* Effect.gen(function*() {
          yield* (yield* FileSystem.FileSystem).writeFileString(`${root}/agents/researcher.json`, "{ not json")
        }).pipe(Effect.provide(BunServices.layer))
        yield* (yield* Agents).reload
        const edited = (yield* roster).find((entry) => entry.id === "researcher")
        expect(edited).toMatchObject({ purpose: "Answer one question.", model: "test/m", knowledge: [`${root}/agents/notes/style.md`] })
        expect(edited!.error).toContain("not valid JSON")
      }).pipe(Effect.provide(service(root, gate)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)

  test("runs --every lists job runs no request started, by their job run id, and result reads them; plain runs lists requests only", () =>
    Effect.gen(function*() {
      const root = yield* home()
      const gate = yield* Deferred.make<void>()
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.gen(function*() {
        const asked = yield* request("tally", { items: ["a"] }, 10_000, "agent:nova")
        expect(asked.job).toBe("count")
        const manual = yield* (yield* Runner).run("tally", "count", { items: ["x"] })
        expect(manual.ok).toBe(true)

        const plain = yield* runs({ days: 7, limit: 10 })
        expect(plain.runs.map((run) => run.run)).toEqual([asked.run])
        expect(plain.runs[0]).toMatchObject({ agent: "tally", job: "count", caller: "agent:nova", summary: '{"items":["a"]}', status: "done" })

        // A trial arm no request started is its trial's to list (blind until a pick), never a job run here.
        yield* (yield* EventBus).publish(new AgentEvent({ id: "arm-b", type: "tally/job.started", component: "tally", job: "count", run: "arm-b", at: new Date().toISOString(), data: { input: { items: [] }, model: "test/code", trial: { id: "t1", letter: "B" } } }))
        const every = yield* runs({ days: 7, limit: 10, every: true })
        expect(every.runs.map((run) => run.run)).toEqual([manual.run, asked.run])
        expect(every.runs[0]).toMatchObject({ run: manual.run, agent: "tally", job: "count", status: "done", model: "test/code", summary: '{"items":["x"]}', cost: 0.25 })
        expect(every.runs[0]).not.toHaveProperty("requestedAt")
        expect(every.runs[0]).not.toHaveProperty("caller")
        expect(every.agents).toEqual(plain.agents)
        expect((yield* runs({ days: 7, limit: 10, every: true, agent: "researcher" })).runs).toEqual([])

        const read = yield* result(manual.run, 0)
        expect(read).toMatchObject({ run: manual.run, agent: "tally", job: "count", status: "done", model: "test/code", cost: 0.25 })
        expect(read.reply).toEqual({
          events: [
            { type: "item.counted", data: { item: "x" } },
            { type: "tally.completed", data: { items: 1, modelCalls: 0, cost: 0.25 } }
          ]
        })
        expect(typeof read.startedAt).toBe("string")
        expect(typeof read.finishedAt).toBe("string")
        expect(typeof read.seconds).toBe("number")
      }).pipe(Effect.provide(service(root, gate)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)

  test("a run reports its thinking level, and the backup model once it fell back (the retry's job.started replaces the first)", () =>
    Effect.gen(function*() {
      const root = yield* home()
      const gate = yield* Deferred.make<void>()
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.gen(function*() {
        const bus = yield* EventBus
        const started = (data: Record<string, unknown>) =>
          bus.publish(new AgentEvent({ id: `fb-${Math.random()}`, type: "tally/job.started", component: "tally", job: "count", run: "fb-1", at: new Date().toISOString(), data: { _tag: "job.started", input: { items: [] }, ...data } }))
        yield* started({ model: "test/code", thinking: "high" })
        const first = (yield* runs({ days: 7, limit: 10, every: true })).runs.find((run) => run.run === "fb-1")
        expect(first).toMatchObject({ model: "test/code", thinking: "high" })
        expect(first).not.toHaveProperty("fellBack")
        yield* started({ model: "test/backup", thinking: "high", fellBackFrom: "test/code" })
        const second = (yield* runs({ days: 7, limit: 10, every: true })).runs.find((run) => run.run === "fb-1")
        expect(second).toMatchObject({ model: "test/backup", thinking: "high", fellBack: true })
      }).pipe(Effect.provide(service(root, gate)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)
})
