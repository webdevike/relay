import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Schedule, Schema, Stream } from "effect"
import { ask, AskTimeout } from "../src/Ask.ts"
import { Background } from "../src/Background.ts"
import { define } from "../src/Component.ts"
import { EventBus, makeEvent } from "../src/Event.ts"
import { ModelError, ModelRunner } from "../src/Model.ts"
import { Runner } from "../src/Runtime.ts"
import { trainingCases } from "../src/components/widget/cases.ts"
import { decide, renderErrors, spec, widget } from "../src/components/widget/component.ts"
import { runtime, tempHome } from "./harness.ts"

/** A model that answers each call with the next scripted reply and records the prompts it saw. */
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

const agent = { model: "test/m", system: "s" }
const request = { draft: "Here is the same helper in TypeScript and Python.", surface: "phone" as const }
const decodeReady = Schema.decodeUnknownEffect(spec.events["widget.ready"])
const ONE_TAB = `root = Tabs([Tab("TS", [Code("const a = 1", "ts")])])`
const TWO_TABS = `root = Tabs([Tab("TS", [Code("const a = 1", "ts")]), Tab("Python", [Code("a = 1", "python")])])`
const body = (block: string) => block.replace(/^```openui\n/, "").replace(/\n```$/, "")

describe("parser gate", () => {
  test("a block the parser rejects goes back once with the parser's errors; the fixed block is emitted", () =>
    Effect.gen(function*() {
      const { models, prompts } = yield* scripted([`why: two languages\n${ONE_TAB}`, `why: two languages\n${TWO_TABS}`])
      const decision = yield* decide(agent, request).pipe(Effect.provideService(ModelRunner, models))
      expect(renderErrors(ONE_TAB).length).toBeGreaterThan(0)
      expect(decision.answer).toEqual({ kind: "openui", block: `\`\`\`openui\n${TWO_TABS}\n\`\`\``, why: "two languages" })
      expect([decision.calls, decision.repaired]).toEqual([2, true])
      expect(decision.cost).toBeCloseTo(0.002)
      expect((yield* Ref.get(prompts))[1]).toContain("Tabs dropped")
    }).pipe(Effect.runPromise))

  test("a block still broken after the repair answers none, never the broken block", () =>
    Effect.gen(function*() {
      const { models, prompts } = yield* scripted([`why: tabs\n${ONE_TAB}`, `why: tabs\nroot = Stat("Only a label"`])
      const decision = yield* decide(agent, request).pipe(Effect.provideService(ModelRunner, models))
      expect(decision.answer.kind).toBe("none")
      expect(decision.answer.block).toBeUndefined()
      expect(decision.answer.why).toStartWith("the block would not render after one repair")
      expect((yield* Ref.get(prompts)).length).toBe(2)
    }).pipe(Effect.runPromise))

  test("thinking aloud around the program never reaches the block, and none answers none in one call", () =>
    Effect.gen(function*() {
      const chatty = yield* scripted([`why: two languages\nHmm, Tabs needs two tabs.\n\`\`\`openui\n${TWO_TABS}\n\`\`\`\nDone.`])
      const block = (yield* decide(agent, request).pipe(Effect.provideService(ModelRunner, chatty.models))).answer.block!
      expect(body(block)).toBe(TWO_TABS)
      expect(renderErrors(body(block))).toEqual([])

      const quiet = yield* scripted(["why: plain chat\nnone"])
      const decision = yield* decide(agent, request).pipe(Effect.provideService(ModelRunner, quiet.models))
      expect(decision.answer).toEqual({ kind: "none", why: "plain chat" })
      expect(decision.calls).toBe(1)
    }).pipe(Effect.runPromise))
})

const contract = { id: widget.id, events: widget.events }
const pair = { request: "widget.requested", reply: "widget.ready" }

describe("ask (request/response over the bus)", () => {
  test("answers the reply carrying its requestId, skipping replies to other requests", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      yield* Effect.gen(function*() {
        const bus = yield* EventBus
        // A responder that first answers someone else, then this request.
        const requests = yield* bus.listen
        yield* requests.pipe(
          Stream.filter((event) => event.type === "widget/widget.requested"),
          Stream.take(1),
          Stream.runForEach((event) =>
            Effect.gen(function*() {
              const { requestId } = yield* Schema.decodeUnknownEffect(spec.events["widget.requested"])(event.data)
              for (const [id, why] of [["someone-else", "decoy"], [requestId, "mine"]] as const) {
                yield* bus.publish(yield* makeEvent({ type: "widget/widget.ready", component: "widget", job: "pick", run: "r", data: { requestId: id, kind: "none", why } }))
              }
            })),
          Effect.forkScoped
        )
        const reply = yield* ask(contract, pair, request, "5 seconds")
        expect(yield* decodeReady(reply.data)).toEqual({ requestId: reply.requestId, kind: "none", why: "mine" })
      }).pipe(Effect.provide(runtime(root, [widget])))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)

  test("no reply within the timeout is an AskTimeout naming the request", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      yield* Effect.gen(function*() {
        const error = yield* ask(contract, pair, request, "300 millis").pipe(Effect.flip)
        if (!(error instanceof AskTimeout)) throw new Error(`expected AskTimeout, got ${error._tag}`)
        expect(error.request).toBe("widget.requested")
      }).pipe(Effect.provide(runtime(root, [widget])))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)

  test("the service's OnEvent trigger answers an ask end to end; a failed model call still answers none at once", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const { models } = yield* scripted([`why: two languages\n${TWO_TABS}`])
      const flaky = yield* Ref.make(false)
      const service = ModelRunner.of({
        generate: (call) =>
          Effect.flatMap(Ref.get(flaky), (down) => down ? Effect.fail(new ModelError({ model: call.model, message: "provider down" })) : models.generate(call))
      })
      yield* Effect.gen(function*() {
        const ok = yield* decodeReady((yield* ask(contract, pair, request, "10 seconds")).data)
        expect(ok.kind).toBe("openui")
        expect(renderErrors(body(ok.block!))).toEqual([])

        yield* Ref.set(flaky, true)
        const down = yield* decodeReady((yield* ask(contract, pair, request, "10 seconds")).data)
        expect(down).toMatchObject({ kind: "none", why: "failed: provider down" })
        // The run itself still fails, after the answer went out.
        yield* (yield* EventBus).history.pipe(
          Effect.flatMap((events) => events.some((event) => event.type === "widget/job.failed") ? Effect.void : Effect.fail("not yet")),
          Effect.retry(Schedule.spaced("100 millis")),
          Effect.timeout("5 seconds")
        )
      }).pipe(Effect.provide(Runner.layerTriggers.pipe(Layer.provideMerge(Background.layer), Layer.provideMerge(runtime(root, [define(spec)], service)))))
    }).pipe(Effect.scoped, Effect.runPromise), 30_000)
})

describe("🎯 training cases (Relay Host's training.jsonl)", () => {
  const line = (fields: Record<string, unknown>) =>
    JSON.stringify({ at: "2026-11-14T00:00:00.000Z", agent: "nova", surface: "phone", draft: "We sold 12 boards in March and 30 in April.", shown: { kind: "none" }, ...fields })
  const CHART = "```openui\nroot = Chart(\"bar\", [Series([12, 30], \"Boards\")], [\"Mar\", \"Apr\"])\n```"

  test("each label sets what the agent should answer: keep is what was shown, plain is none, other is not scored", () => {
    const { cases, skipped } = trainingCases([
      line({ message: "assistant@1", label: "keep", shown: { kind: "openui", source: "widget", block: CHART } }),
      line({ message: "assistant@2", label: "keep" }),
      line({ message: "assistant@3", label: "plain", shown: { kind: "openui", source: "widget", block: CHART } }),
      line({ message: "assistant@4", label: "table" }),
      line({ message: "assistant@5", label: "other" }),
      "{torn"
    ].join("\n"))
    expect(cases.map((item) => [item.id, item.expect])).toEqual([
      ["trained-assistant@1", ["chart"]],
      ["trained-assistant@2", []],
      ["trained-assistant@3", []],
      ["trained-assistant@4", ["table"]]
    ])
    expect(skipped).toBe(2)
  })

  test("Isaac's latest answer on a reply wins, and a reply's own widget is cut from the draft it is benched on", () => {
    const draft = `Here are the counts.\n\n${CHART}\n\nUp 150%.`
    const { cases } = trainingCases([
      line({ message: "assistant@7", label: "plain", draft, shown: { kind: "openui", source: "reply", block: CHART } }),
      line({ message: "assistant@7", label: "keep", draft, shown: { kind: "openui", source: "reply", block: CHART } })
    ].join("\n"))
    expect(cases).toHaveLength(1)
    expect(cases[0]?.expect).toEqual(["chart"])
    expect(cases[0]?.draft).toBe("Here are the counts.\n\n\n\nUp 150%.")
    expect(cases[0]?.source).toBe("training.jsonl:2")
  })
})
