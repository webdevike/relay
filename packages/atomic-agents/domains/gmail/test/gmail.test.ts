import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Option, Ref, Schema } from "effect"
import { omp } from "../../../src/core/adapters/omp.ts"
import { Cursor, Gmail, gmailPack, type Message } from "../adapters/pack.ts"
import { EventBus } from "../../../src/core/Event.ts"
import { generateWithTools, ModelError, ModelRunner, tool, ToolLoopError } from "../../../src/core/Model.ts"
import { Runner } from "../../../src/core/Runtime.ts"
import { builtinAgents, runtime, tempHome } from "../../../test/harness.ts"

/** A model that answers each call with the next scripted reply (the last one repeats) and records the prompts it saw. */
const scripted = (replies: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const prompts = yield* Ref.make<ReadonlyArray<string>>([])
    const models = ModelRunner.of({
      generate: (request) =>
        Ref.modify(prompts, (seen) => [seen.length, [...seen, request.prompt]]).pipe(
          Effect.map((index) => ({ text: replies[Math.min(index, replies.length - 1)]!, model: request.model, provider: "test", seconds: 0, cost: 0.001 }))
        )
    })
    return { models, prompts }
  })

const answer = JSON.stringify({ answer: { verdict: "noise", reason: "promo", title: "Promo" } })

describe("tool loop", () => {
  const request = { model: "test/m", system: "s", prompt: "classify" }
  const options = (runs: Ref.Ref<ReadonlyArray<string>>) => ({
    tools: [tool({
      name: "read_thread",
      description: "thread",
      args: Schema.Struct({ id: Schema.String }),
      example: `{"id": "<id>"}`,
      run: ({ id }: { readonly id: string }) => Ref.update(runs, (all) => [...all, id]).pipe(Effect.as({ messages: 1 }))
    })],
    answer: Schema.Struct({ verdict: Schema.String }),
    answerExample: `{"verdict": "..."}`,
    maxSteps: 3
  })

  test("a model that never answers stops at maxSteps model calls with ToolLoopError, the last turn running no tool", () =>
    Effect.gen(function*() {
      const { models, prompts } = yield* scripted([JSON.stringify({ tool: "read_thread", args: { id: "t1" } })])
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const error = yield* generateWithTools(request, options(runs)).pipe(Effect.provideService(ModelRunner, models), Effect.flip)
      if (!(error instanceof ToolLoopError)) throw new Error(`expected ToolLoopError, got ${error._tag}`)
      expect(error.steps).toBe(3)
      expect((yield* Ref.get(prompts)).length).toBe(3)
      expect(yield* Ref.get(runs)).toEqual(["t1", "t1"])
      expect((yield* Ref.get(prompts))[2]).toContain("last reply: tools are closed")
    }).pipe(Effect.runPromise))

  test("a tool outside the allowlist never runs; the model is told which it may call, then a listed tool runs and the answer decodes", () =>
    Effect.gen(function*() {
      const { models, prompts } = yield* scripted([
        "Sure: ```json\n{\"tool\": \"archive\", \"args\": {\"id\": \"m1\"}}\n```",
        JSON.stringify({ tool: "read_thread", args: { id: "m1" } }),
        JSON.stringify({ answer: { verdict: "fyi" } })
      ])
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const result = yield* generateWithTools(request, options(runs)).pipe(Effect.provideService(ModelRunner, models))
      expect(result.answer).toEqual({ verdict: "fyi" })
      expect(result.calls).toEqual([{ tool: "archive", allowed: false }, { tool: "read_thread", allowed: true }])
      expect(yield* Ref.get(runs)).toEqual(["m1"])
      expect((yield* Ref.get(prompts))[1]).toContain("error: no tool archive; you may only call: read_thread")
      expect(result.steps).toBe(3)
      expect(result.cost).toBeCloseTo(0.003)
    }).pipe(Effect.runPromise))

  test("bad JSON and an answer that fails its schema are fed back, not fatal", () =>
    Effect.gen(function*() {
      const { models, prompts } = yield* scripted(["noise, clearly", JSON.stringify({ answer: { verdict: 7 } }), JSON.stringify({ answer: { verdict: "noise" } })])
      const runs = yield* Ref.make<ReadonlyArray<string>>([])
      const result = yield* generateWithTools(request, options(runs)).pipe(Effect.provideService(ModelRunner, models))
      expect(result.answer).toEqual({ verdict: "noise" })
      const [, second, third] = yield* Ref.get(prompts)
      expect(second).toContain(`error: not one JSON object`)
      expect(third).toContain("error: bad answer")
    }).pipe(Effect.runPromise))
})

const VALIDITY = 7

const message = (uid: number, subject = `message ${uid}`): Message => ({
  uid, id: `<m${uid}@x>`, from: "Shop", address: "shop@x.com", to: "isaac", subject, date: "2026-11-14T00:00:00Z", labels: [], bulk: true, body: ""
})

/** All Mail as `mail.py` serves it: after the cursor when its validity matches, else everything; `through` is the newest UID. */
const fakeGmail = (box: Ref.Ref<ReadonlyArray<Message>>) =>
  Layer.succeed(Gmail, Gmail.of({
    since: (cursor, limit) =>
      Ref.get(box).pipe(Effect.map((all) => {
        const fresh = all.filter((candidate) => cursor === undefined || cursor.validity !== VALIDITY || candidate.uid > cursor.uid)
        const batch = fresh.slice(0, limit)
        return { validity: VALIDITY, through: fresh.length > limit ? batch.at(-1)!.uid : Math.max(0, ...all.map((m) => m.uid)), messages: batch }
      })),
    byId: (ids) => Ref.get(box).pipe(Effect.map((all) => ({ validity: VALIDITY, through: 0, messages: all.filter((m) => ids.includes(m.id)) }))),
    readThread: () => Effect.succeed({}),
    senderHistory: () => Effect.succeed({})
  }))

/** Answers noise, except it errors on a message whose subject is "poison" while `poisoned` is set; keeps the system prompts it saw. */
const triageModel = (poisoned: Ref.Ref<boolean>, systems: Ref.Ref<ReadonlyArray<string>>) =>
  ModelRunner.of({
    generate: (request) =>
      Ref.update(systems, (seen) => [...seen, request.system]).pipe(Effect.andThen(Ref.get(poisoned)), Effect.flatMap((poison) =>
        poison && request.prompt.includes("Subject: poison")
          ? Effect.fail(new ModelError({ model: request.model, message: "provider down" }))
          : Effect.succeed({ text: answer, model: request.model, provider: "test", seconds: 0, cost: 0.001 })))
  })

const Triaged = Schema.Struct({ id: Schema.String, from: Schema.String, subject: Schema.String, date: Schema.String, verdict: Schema.String, reason: Schema.String, title: Schema.String })

describe("gmail triage cursor", () => {
  test("each run triages only mail after the cursor; a failed message is retried next run; a replay leaves the cursor alone", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const box = yield* Ref.make<ReadonlyArray<Message>>([message(10), message(11)])
      const poisoned = yield* Ref.make(false)
      const systems = yield* Ref.make<ReadonlyArray<string>>([])
      const dir = yield* builtinAgents(root, ["gmail"])
      // Nova's Catch Up taste, where the agent file's knowledge paths point (${EVA_ROOT}).
      yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(`${root}/eva/work/eva/agents/nova`, { recursive: true })
        yield* fs.writeFileString(`${root}/eva/work/eva/agents/nova/catchup-taste.md`, "Isaac skips promos.\n")
        yield* fs.writeFileString(`${root}/eva/work/eva/agents/nova/catchup-rules.json`, "{\"rules\": []}\n")
      }).pipe(Effect.provide(BunServices.layer))
      const world = { dirs: [dir], packs: [omp, gmailPack(fakeGmail(box))], env: { EVA_ROOT: `${root}/eva` } }
      yield* Effect.gen(function*() {
        const runner = yield* Runner
        const bus = yield* EventBus
        const fs = yield* FileSystem.FileSystem
        const cursor = fs.readFileString(`${root}/state/gmail/cursor.json`).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))))
        const triaged = (run: string) =>
          bus.history.pipe(Effect.flatMap((events) =>
            Effect.forEach(events.filter((event) => event.run === run && event.type === "gmail/message.triaged"), (event) =>
              Effect.map(Schema.decodeUnknownEffect(Triaged, { onExcessProperty: "error" })(event.data), (data) => data.id))))

        const first = yield* runner.run("gmail", "triage", {})
        expect(yield* triaged(first.run)).toEqual(["<m10@x>", "<m11@x>"])
        expect(yield* cursor).toEqual({ validity: VALIDITY, uid: 11 })
        const [system] = yield* Ref.get(systems)
        expect(system).toContain("## Isaac's taste (Nova's notes from his Catch Up cards)\nIsaac skips promos.\n\n## catchup-rules.json (the same taste as rules Catch Up applies)\n{\"rules\": []}")
        expect(system).toContain("- read_thread {\"id\": \"<message id>\"}")

        yield* Ref.set(box, [message(10), message(11), message(12), message(13, "poison"), message(14)])
        yield* Ref.set(poisoned, true)
        const failed = yield* runner.run("gmail", "triage", {})
        expect(failed.ok).toBe(false)
        expect(yield* triaged(failed.run)).toEqual(["<m12@x>"])
        expect(yield* cursor).toEqual({ validity: VALIDITY, uid: 12 })

        yield* Ref.set(poisoned, false)
        const resumed = yield* runner.run("gmail", "triage", {})
        expect(yield* triaged(resumed.run)).toEqual(["<m13@x>", "<m14@x>"])
        expect(yield* cursor).toEqual({ validity: VALIDITY, uid: 14 })

        const replay = yield* runner.run("gmail", "triage", { ids: ["<m10@x>"] })
        expect(yield* triaged(replay.run)).toEqual(["<m10@x>"])
        expect(yield* cursor).toEqual({ validity: VALIDITY, uid: 14 })

        const idle = yield* runner.run("gmail", "triage", {})
        expect(idle.ok).toBe(true)
        expect(yield* triaged(idle.run)).toEqual([])
        const completed = (yield* bus.history).find((event) => event.run === idle.run && event.type === "gmail/triage.completed")
        expect(Option.fromUndefinedOr(completed?.data)).toEqual(Option.some({ messages: 0, modelCalls: 0, cost: 0, replay: false }))
      }).pipe(Effect.provide(runtime(root, world, triageModel(poisoned, systems))))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)
})
