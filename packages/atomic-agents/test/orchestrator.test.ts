import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, FileSystem, Layer, Ref } from "effect"
import { Chefs } from "../src/Chef.ts"
import { EventBus } from "../src/Event.ts"
import { ModelRunner } from "../src/Model.ts"
import { Orchestrators, parseOrchestrator, Reporter, Sessions, stopsHit } from "../src/Orchestrator.ts"
import { builtinChefs, oneProcess, runtime, tempHome } from "./harness.ts"

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** A minimal orchestrator whose measure prints `points` as `R<n> <value>` lines. */
const spec = (points: ReadonlyArray<number>, extra: Record<string, unknown> = {}) => ({
  id: "loop",
  goal: "The loop scores 8.",
  measure: {
    label: "critic mean",
    command: ["printf", points.map((value, index) => `R${index + 1} ${value}\\n`).join("")],
    target: { op: ">=", value: 8 }
  },
  chefs: [],
  model: "test/m",
  cadence: "loop",
  budget: { maxHoursPerDay: 4, maxRuns: 3, maxUsd: 1 },
  stop: [{ when: "flat", rounds: 2, then: "ask" }, { when: "met", then: "pause" }],
  steps: {
    build: { kind: "session", description: "Build round {round}.", model: "test/m", thinking: "off", title: "round {{round}}", task: "Build round {{round}}.", done: "ROUND{{round}}-DONE" }
  },
  ...extra
})

const world = (root: string, said: Ref.Ref<ReadonlyArray<string>>, models?: ModelRunner["Service"]) =>
  Orchestrators.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(
      Layer.succeed(Sessions, Sessions.of({ start: () => Effect.succeed("session-1"), state: () => Effect.succeed("running") })),
      Layer.succeed(Reporter, Reporter.of({ say: (agent, text) => Ref.update(said, (all) => [...all, `${agent}: ${text}`]) }))
    )),
    Layer.provideMerge(runtime(root, {}, models))
  )

const writeOrchestrator = (root: string, value: unknown) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(`${root}/orchestrators`, { recursive: true })
    yield* fs.writeFileString(`${root}/orchestrators/loop.json`, json(value))
  }).pipe(Effect.provide(BunServices.layer))

describe("orchestrator file validation", () => {
  test("an unknown chef, a step on a chef outside chefs, and a bad cron are load errors naming what is loaded", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const dir = yield* builtinChefs(root, ["widget"])
      const message = yield* Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(`${root}/orchestrators`)
        const chefs = yield* (yield* Chefs).current
        return yield* parseOrchestrator(`${root}/orchestrators/loop.json`, json(spec([5], {
          chefs: ["ghost"],
          cadence: { cron: "every tuesday" },
          steps: { ask: { kind: "chef", description: "Ask.", chef: "widget", request: "widget.requested" } }
        })), chefs).pipe(Effect.flip, Effect.map((error) => error.message))
      }).pipe(Effect.provide(oneProcess(root, { dirs: [dir] })))
      expect(message).toContain("chefs: unknown chef ghost (loaded: widget)")
      expect(message).toContain("steps.ask: chef widget is not in chefs")
      expect(message).toContain(`cadence: bad cron "every tuesday"`)
    }).pipe(Effect.scoped, Effect.runPromise))
})

describe("stop rules", () => {
  const target = { op: ">=", value: 8 } as const
  const series = (values: ReadonlyArray<number>) => values.map((value, index) => ({ label: `R${index + 10}`, value }))
  const flat3 = [{ when: "flat", rounds: 3, epsilon: 0.05, then: "ask" }, { when: "met", then: "pause" }] as const

  test("flat hits when none of the last N rounds beat the best before them by more than epsilon", () => {
    // Solstice R10-R18: best before the last three is 7.4 (R15); R16-R18 are 7.4, 7.3, 7.3.
    const hit = stopsHit(flat3, series([6.4, 6.3, 6.3, 6.6, 7.0, 7.4, 7.4, 7.3, 7.3]), target)
    expect(hit.map((stop) => [stop.rule, stop.then])).toEqual([["flat 3", "ask"]])
    // A gain inside epsilon is still flat; one past it is progress.
    expect(stopsHit(flat3, series([7.0, 7.4, 7.44, 7.3, 7.3]), target).map((stop) => stop.rule)).toEqual(["flat 3"])
    expect(stopsHit(flat3, series([7.0, 7.4, 7.5, 7.3, 7.3]), target)).toEqual([])
    // Not enough history to judge.
    expect(stopsHit(flat3, series([7.4, 7.3, 7.3]), target)).toEqual([])
  })

  test("met reads the latest value against the target, either direction", () => {
    expect(stopsHit(flat3, series([6, 7, 8]), target).map((stop) => [stop.rule, stop.then])).toEqual([["met", "pause"]])
    expect(stopsHit(flat3, series([8, 7.9]), target)).toEqual([])
    const lower = { op: "<=", value: 2 } as const
    expect(stopsHit([{ when: "met", then: "pause" }], series([3, 2]), lower).map((stop) => stop.rule)).toEqual(["met"])
    // Lower is better: 3 -> 2.5 -> 2.6 -> 2.7 is flat after the 2.5.
    expect(stopsHit([{ when: "flat", rounds: 2, then: "ask" }], series([3, 2.5, 2.6, 2.7]), lower).map((stop) => stop.rule)).toEqual(["flat 2"])
  })

  test("a live tick that hits a stop rule pauses before planning, tells reportTo, and stays paused until resumed", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const said = yield* Ref.make<ReadonlyArray<string>>([])
      yield* writeOrchestrator(root, spec([7, 7, 7]))
      yield* Effect.gen(function*() {
        const orchestrators = yield* Orchestrators
        const bus = yield* EventBus
        const first = yield* orchestrators.tick("loop", "live")
        expect([first.status, first.plan]).toEqual(["stopped", undefined])
        expect((yield* orchestrators.state("loop")).paused?.rule).toBe("flat 2")
        const paused = (yield* bus.history).filter((event) => event.type === "loop/orchestrator.paused")
        expect(paused.map((event) => event.data)).toEqual([{ reportTo: "nova", why: "flat for 2 rounds: R2 7, R3 7 vs best before 7", rule: "flat 2" }])
        expect((yield* Ref.get(said))[0]).toStartWith("nova: loop needs Isaac: flat for 2 rounds")

        expect((yield* orchestrators.tick("loop", "live")).status).toBe("paused")
        yield* orchestrators.resume("loop", "isaac")
        expect((yield* orchestrators.state("loop")).paused).toBeNull()
      }).pipe(Effect.provide(world(root, said)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)
})

describe("single tick", () => {
  test("a second tick while one is planning answers busy and runs nothing; the first finishes with its plan", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const said = yield* Ref.make<ReadonlyArray<string>>([])
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const calls = yield* Ref.make(0)
      const plan = { decision: "dispatch", why: "round 1 next", dispatch: [{ step: "build", input: { round: 1 } }], next: "ROUND1-DONE", needs: [] }
      const models = ModelRunner.of({
        generate: (request) =>
          Ref.update(calls, (n) => n + 1).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Deferred.await(release)),
            Effect.as({ text: JSON.stringify({ answer: plan }), model: request.model, provider: "test", seconds: 0, cost: 0.01 })
          )
      })
      yield* writeOrchestrator(root, spec([5, 6]))
      yield* Effect.gen(function*() {
        const orchestrators = yield* Orchestrators
        const first = yield* Effect.forkChild(orchestrators.tick("loop", "dry"))
        yield* Deferred.await(entered)
        const second = yield* orchestrators.tick("loop", "live")
        expect([second.status, second.why]).toEqual(["busy", "a tick is already running"])
        yield* Deferred.succeed(release, undefined)
        const done = yield* Fiber.join(first)
        expect([done.status, done.plan?.decision, yield* Ref.get(calls)]).toEqual(["planned", "dispatch", 1])
        expect(done.dispatches.map((entry) => [entry.step, entry.kind, entry.error])).toEqual([["build", "session", undefined]])
        expect(done.dispatches[0]!.what).toContain(`--title "round 1"`)
        // A dry run writes nothing.
        expect(yield* orchestrators.state("loop")).toEqual({ paused: null, pending: [], runs: 0, usd: 0, hours: {}, ticks: 0 })
      }).pipe(Effect.provide(world(root, said, models)))
    }).pipe(Effect.scoped, Effect.runPromise), 20_000)
})
