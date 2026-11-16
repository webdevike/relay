import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Ref } from "effect"
import { Browser, browserPack } from "../adapters/browser.ts"
import { packs as defaultPacks } from "../../../src/packs.ts"
import { MEASURED, UiCheck, uiCheckPack } from "../adapters/uicheck.ts"
import { EventBus } from "../../../src/core/Event.ts"
import { type GenerateRequest, ModelRunner } from "../../../src/core/Model.ts"
import { Runner } from "../../../src/core/Runtime.ts"
import { builtinAgents, runtime, tempHome } from "../../../test/harness.ts"

/** Answers each call with the next scripted reply; records every request. */
const scripted = (replies: ReadonlyArray<unknown>) =>
  Effect.gen(function*() {
    const seen = yield* Ref.make<ReadonlyArray<GenerateRequest>>([])
    const models = ModelRunner.of({
      generate: (request) =>
        Ref.modify(seen, (all) => [all.length, [...all, request]]).pipe(
          Effect.map((index) => ({ text: JSON.stringify({ answer: replies[Math.min(index, replies.length - 1)] }), model: request.model, provider: "test", seconds: 0, cost: 0.01 }))
        )
    })
    return { models, seen }
  })

/** Shots are paths in the run dir, never a real browser; ui-check answers `measured`, or dies when it must not run. */
const fakes = (measured: ReadonlyArray<{ rule: string; severity: "error" | "warn" | "info" }> | "never") => [
  ...defaultPacks.filter((candidate) => candidate.name !== "browser" && candidate.name !== "ui-check"),
  browserPack(Layer.succeed(Browser, Browser.of({
    capture: (url, viewports, dir) => Effect.succeed({ url, title: "Reports", shots: viewports.map((viewport) => ({ viewport, file: `${dir}/shot-${viewport}.png` })) })
  }))),
  uiCheckPack(Layer.succeed(UiCheck, UiCheck.of({
    measure: () =>
      measured === "never"
        ? Effect.die(new Error("ui-check must not run without a url"))
        : Effect.succeed(measured.map((entry, index) => ({ ...entry, selector: `div:nth-of-type(${index + 1})`, viewport: [1280], fix: `fix ${entry.rule}` })))
  })))
]

/** Run the shipped design-critic agent once over a temp home; answer its design.critique data and the model requests. */
const critique = (input: Readonly<Record<string, unknown>>, replies: ReadonlyArray<unknown>, measured: Parameters<typeof fakes>[0]) =>
  Effect.gen(function*() {
    const root = yield* tempHome
    const dir = yield* builtinAgents(root, ["design-critic"])
    const { models, seen } = yield* scripted(replies)
    return yield* Effect.gen(function*() {
      const result = yield* (yield* Runner).run("design-critic", "critique", input, { model: "test/vision" })
      const events = yield* (yield* EventBus).history
      const output = events.find((event) => event.type === "design-critic/design.critique" && event.run === result.run)
      return { ok: result.ok, data: output?.data as Record<string, any> | undefined, requests: yield* Ref.get(seen) }
    }).pipe(Effect.provide(runtime(root, { dirs: [dir], packs: fakes(measured) }, models)))
  }).pipe(Effect.scoped)

const finding = (rule: string, severity: string) => ({ rule, element: `the ${rule} element`, fix: `fix the ${rule}`, severity })

describe("design-critic", () => {
  test("a url is shot at each viewport and attached on every call; a bad score is repaired once; findings come out ranked with ui-check evidence", () =>
    Effect.gen(function*() {
      const valid = { score: 4.5, findings: [finding("alignment", "minor"), finding("clipped-text", "blocking"), finding("hierarchy", "major")], summary: "Fix the clipped label." }
      const { ok, data, requests } = yield* critique(
        { url: "https://example.test/reports", viewports: [375, 1280], intent: "Reports list" },
        [{ ...valid, score: 45 }, valid],
        [{ rule: "text-clipped", severity: "error" }, { rule: "off-scale", severity: "warn" }, { rule: "misaligned", severity: "info" }]
      )
      expect(ok).toBe(true)
      expect(requests.length).toBe(2)
      expect(requests[1]!.prompt).toContain("score 45 is outside 0 to 10")
      for (const request of requests) {
        expect(request.files?.map((file) => file.split("/").at(-1))).toEqual(["shot-375.png", "shot-1280.png"])
        expect(request.system).toContain("`vibe-coded`")
      }
      expect(requests[0]!.prompt).toContain("What this screen is for: Reports list")
      expect(requests[0]!.prompt).toContain(`https://example.test/reports ("Reports"), shot full page at 375px and 1280px wide`)
      expect(data!["score"]).toBe(4.5)
      expect(data!["attempts"]).toBe(2)
      // Blocking, major, minor; measured only on measurable rules, true only when ui-check found that kind of defect.
      expect(data!["findings"].map((entry: { rule: string; measured?: boolean }) => [entry.rule, entry.measured])).toEqual([
        ["clipped-text", true],
        ["hierarchy", undefined],
        ["alignment", false]
      ])
      // Errors first, info dropped.
      expect(data!["evidence"].map((entry: { rule: string }) => entry.rule)).toEqual(["text-clipped", "off-scale"])
    }).pipe(Effect.runPromise), 20_000)

  test("a screenshot is critiqued as is: no browser, no ui-check, no evidence; a critique still invalid after the repair fails the run", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const shot = yield* fs.makeTempFileScoped({ suffix: ".png" })
      const passed = yield* critique({ screenshot: shot, intent: "Settings page" }, [{ score: 8, findings: [finding("whitespace", "minor")], summary: "Fine." }], "never")
      expect(passed.ok).toBe(true)
      expect(passed.requests[0]!.files).toEqual([shot])
      expect(passed.data!["evidence"]).toBeUndefined()
      expect(passed.data!["findings"][0]["measured"]).toBeUndefined()

      const failed = yield* critique({ screenshot: shot, intent: "Settings page" }, [{ score: 6, findings: [], summary: "Meh." }], "never")
      expect(failed.ok).toBe(false)
      expect(failed.data).toBeUndefined()
      expect(failed.requests.length).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.runPromise), 20_000)

  test("every rule the model may cite is defined in the rules file, and every rule there is citable", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const agent = JSON.parse(yield* fs.readFileString(new URL("../design-critic.json", import.meta.url).pathname))
      const citable: ReadonlyArray<string> = agent.job.answer.findings.array.rule.enum
      const rules = yield* fs.readFileString(new URL("../design-critic.rules.md", import.meta.url).pathname)
      const defined = [...rules.matchAll(/^- `([a-z-]+)`:/gm)].map((match) => match[1])
      expect([...citable].sort()).toEqual([...defined].sort() as Array<string>)
      for (const rule of Object.keys(MEASURED)) expect(citable).toContain(rule)
    }).pipe(Effect.provide(BunServices.layer), Effect.runPromise))
})
