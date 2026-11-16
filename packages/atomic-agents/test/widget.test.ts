import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Schedule, Schema, Stream } from "effect"
import { ask, AskTimeout } from "../src/Ask.ts"
import { renderErrors } from "../src/adapters/openui.ts"
import { Background } from "../src/Background.ts"
import { trainingCases } from "../src/bench/widget-cases.ts"
import { EventBus, makeEvent } from "../src/Event.ts"
import { ModelError, ModelRunner } from "../src/Model.ts"
import { Runner } from "../src/Runtime.ts"
import { builtinChefs, chef, runtime, tempHome } from "./harness.ts"

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

const request = { draft: "Here is the same helper in TypeScript and Python.", surface: "phone" as const }
const ONE_TAB = `root = Tabs([Tab("TS", [Code("const a = 1", "ts")])])`
const TWO_TABS = `root = Tabs([Tab("TS", [Code("const a = 1", "ts")]), Tab("Python", [Code("a = 1", "python")])])`
const body = (block: string) => block.replace(/^```openui\n/, "").replace(/\n```$/, "")
const Ready = Schema.Struct({ requestId: Schema.String, kind: Schema.Literals(["openui", "none"]), block: Schema.optionalKey(Schema.String), why: Schema.String })
const decodeReady = Schema.decodeUnknownEffect(Ready)

/** The widget chef as shipped (`chefs/widget.json`), loaded over a temp home with `models` answering. */
const withWidget = <A, E, R>(models: ModelRunner["Service"], body: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const root = yield* tempHome
    const dir = yield* builtinChefs(root, ["widget"])
    return yield* body(root).pipe(Effect.provide(runtime(root, { dirs: [dir] }, models)))
  }).pipe(Effect.scoped)

/** One item through the chef's model stage, as the bench calls it. */
const decide = (fields: Readonly<Record<string, unknown>>) =>
  Effect.gen(function*() {
    const widget = yield* chef("widget")
    return yield* widget.cook!.item(fields, {
      component: "widget", job: "pick", run: "test", runDir: "", stateDir: "", model: "test/m", agent: { ...widget.agent, model: "test/m" }
    })
  })

describe("parser gate (openui.parse check)", () => {
  test("a block the parser rejects goes back once with the parser's errors; the fixed block is emitted", () =>
    Effect.gen(function*() {
      const { models, prompts } = yield* scripted([`why: two languages\n${ONE_TAB}`, `why: two languages\n${TWO_TABS}`])
      const decision = yield* withWidget(models, () => decide(request))
      expect(renderErrors(ONE_TAB).length).toBeGreaterThan(0)
      expect(decision.fields).toEqual({ kind: "openui", block: `\`\`\`openui\n${TWO_TABS}\n\`\`\``, why: "two languages" })
      expect(decision.attempts).toBe(2)
      expect(decision.cost).toBeCloseTo(0.002)
      const [first, repair] = yield* Ref.get(prompts)
      expect(first).toBe(`Surface: phone\nDraft reply:\n${request.draft}\nData:\n(none)`)
      expect(repair).toContain("Tabs dropped")
      expect(repair).toStartWith(`${first}\n\n## Your last reply`)
    }).pipe(Effect.runPromise), 20_000)

  test("a block still broken after the repair answers none, never the broken block", () =>
    Effect.gen(function*() {
      const { models, prompts } = yield* scripted([`why: tabs\n${ONE_TAB}`, `why: tabs\nroot = Stat("Only a label"`])
      const decision = yield* withWidget(models, () => decide(request))
      expect(decision.fields["kind"]).toBe("none")
      expect(decision.fields["block"]).toBeUndefined()
      expect(String(decision.fields["why"])).toStartWith("the block would not render after one repair")
      expect((yield* Ref.get(prompts)).length).toBe(2)
    }).pipe(Effect.runPromise), 20_000)

  test("thinking aloud around the program never reaches the block, and none answers none in one call", () =>
    Effect.gen(function*() {
      const chatty = yield* scripted([`why: two languages\nHmm, Tabs needs two tabs.\n\`\`\`openui\n${TWO_TABS}\n\`\`\`\nDone.`])
      const block = String((yield* withWidget(chatty.models, () => decide(request))).fields["block"])
      expect(body(block)).toBe(TWO_TABS)
      expect(renderErrors(body(block))).toEqual([])

      const quiet = yield* scripted(["why: plain chat\nnone"])
      const decision = yield* withWidget(quiet.models, () => decide({ ...request, context: { channel: "voice", askedForDetail: true }, data: { n: 1 } }))
      expect(decision.fields).toEqual({ kind: "none", why: "plain chat" })
      expect(decision.attempts).toBe(1)
      expect((yield* Ref.get(quiet.prompts))[0]).toBe(`Surface: phone\nIsaac asked on a call, for detail.\nDraft reply:\n${request.draft}\nData:\n{\n "n": 1\n}`)
    }).pipe(Effect.runPromise), 20_000)

  test("a form Isaac picked rides the prompt, so the model is told which widget to draw", () =>
    Effect.gen(function*() {
      const { models, prompts } = yield* scripted([`why: picked\n${TWO_TABS}`])
      yield* withWidget(models, () => decide({ ...request, form: "table" }))
      expect((yield* Ref.get(prompts))[0]).toBe(`Surface: phone\nIsaac picked the form: table. Answer with a table program built from the draft, never none.\nDraft reply:\n${request.draft}\nData:\n(none)`)
    }).pipe(Effect.runPromise), 20_000)
})

const pair = { request: "widget.requested", reply: "widget.ready" }
const idle = ModelRunner.of({ generate: () => Effect.die("no model calls") })

describe("ask (request/response over the bus)", () => {
  test("answers the reply carrying its requestId, skipping replies to other requests", () =>
    withWidget(idle, () =>
      Effect.gen(function*() {
        const bus = yield* EventBus
        const widget = yield* chef("widget")
        // A responder that first answers someone else, then this request.
        const requests = yield* bus.listen
        yield* requests.pipe(
          Stream.filter((event) => event.type === "widget/widget.requested"),
          Stream.take(1),
          Stream.runForEach((event) =>
            Effect.gen(function*() {
              const { requestId } = yield* Schema.decodeUnknownEffect(Schema.Struct({ requestId: Schema.String }))(event.data)
              for (const [id, why] of [["someone-else", "decoy"], [requestId, "mine"]] as const) {
                yield* bus.publish(yield* makeEvent({ type: "widget/widget.ready", component: "widget", job: "pick", run: "r", data: { requestId: id, kind: "none", why } }))
              }
            })),
          Effect.forkScoped
        )
        const reply = yield* ask(widget, pair, request, "5 seconds")
        expect(yield* decodeReady(reply.data)).toEqual({ requestId: reply.requestId, kind: "none", why: "mine" })
        expect(widget.asks?.show(reply.data)).toBe("none")
      }).pipe(Effect.scoped)).pipe(Effect.runPromise), 20_000)

  test("no reply within the timeout is an AskTimeout naming the request", () =>
    withWidget(idle, () =>
      Effect.gen(function*() {
        const error = yield* ask(yield* chef("widget"), pair, request, "300 millis").pipe(Effect.flip)
        if (!(error instanceof AskTimeout)) throw new Error(`expected AskTimeout, got ${error._tag}`)
        expect(error.request).toBe("widget.requested")
      })).pipe(Effect.runPromise), 20_000)

  test("the service's OnEvent trigger answers an ask end to end; a failed model call still answers none at once", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const dir = yield* builtinChefs(root, ["widget"])
      const { models } = yield* scripted([`why: two languages\n${TWO_TABS}`])
      const flaky = yield* Ref.make(false)
      const service = ModelRunner.of({
        generate: (call) =>
          Effect.flatMap(Ref.get(flaky), (down) => down ? Effect.fail(new ModelError({ model: call.model, message: "provider down" })) : models.generate(call))
      })
      yield* Effect.gen(function*() {
        const widget = yield* chef("widget")
        const ok = yield* decodeReady((yield* ask(widget, pair, request, "10 seconds")).data)
        expect(ok.kind).toBe("openui")
        expect(renderErrors(body(ok.block!))).toEqual([])
        expect(widget.asks?.show(ok)).toBe(ok.block)

        yield* Ref.set(flaky, true)
        const down = yield* decodeReady((yield* ask(widget, pair, request, "10 seconds")).data)
        expect(down).toMatchObject({ kind: "none", why: "failed: provider down" })
        // The run itself still fails, after the answer went out.
        yield* (yield* EventBus).history.pipe(
          Effect.flatMap((events) => events.some((event) => event.type === "widget/job.failed") ? Effect.void : Effect.fail("not yet")),
          Effect.retry(Schedule.spaced("100 millis")),
          Effect.timeout("5 seconds")
        )
      }).pipe(Effect.provide(Runner.layerTriggers.pipe(Layer.provideMerge(Background.layer), Layer.provideMerge(runtime(root, { dirs: [dir] }, service)))))
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
