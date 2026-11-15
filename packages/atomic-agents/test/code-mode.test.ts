import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { Effect, Option, Ref, Schema } from "effect"
import { toolAdapter } from "../src/Adapter.ts"
import { parseChef } from "../src/Chef.ts"
import { codeTool } from "../src/CodeMode.ts"
import { EventBus, lifecycle } from "../src/Event.ts"
import { type GenerateRequest, ModelRunner } from "../src/Model.ts"
import { Runner } from "../src/Runtime.ts"
import { Settings } from "../src/Settings.ts"
import { builtinChefs, oneProcess, runtime, tempHome } from "./harness.ts"

const echo = toolAdapter({
  name: "test.echo",
  description: "Echoes its text.",
  args: Schema.Struct({ text: Schema.String }),
  example: `{"text": "<text>"}`,
  returns: Schema.Struct({ text: Schema.String, caller: Schema.Literals(["model", "script"]) }),
  run: ({ text }, _, caller) => text === "fail" ? Effect.fail({ message: "echo refused" }) : Effect.succeed({ text, caller })
})

const run = (code: string) =>
  codeTool([echo], {}).call({ code }).pipe(Effect.map((text) => JSON.parse(text)), Effect.provide(BunServices.layer), Effect.runPromise)

describe("code mode sandbox", () => {
  test("a script reaches tools only through its functions: no network, no other process, no reads under home, writes only in its temp dir", async () => {
    const escape = `${homedir()}/atomic-code-escape-${process.pid}.txt`
    const out = await run([
      `const out = { echo: await echo({ text: "hi" }) }`,
      `try { await echo({ text: "fail" }) } catch (error) { out.refused = error.message }`,
      `try { await fetch("http://1.1.1.1"); out.fetch = "allowed" } catch { out.fetch = "blocked" }`,
      `try { await Bun.write(${JSON.stringify(escape)}, "x"); out.write = "allowed" } catch { out.write = "blocked" }`,
      `try { Bun.spawnSync(["/bin/echo"]); out.spawn = "allowed" } catch { out.spawn = "blocked" }`,
      `try { await Bun.file(${JSON.stringify(`${homedir()}/.zshrc`)}).text(); out.read = "allowed" } catch { out.read = "blocked" }`,
      `await Bun.write("./scratch.txt", "x"); out.temp = "written"`,
      `return out`
    ].join("\n"))
    expect(out).toEqual({ result: { echo: { text: "hi", caller: "script" }, refused: "echo refused", fetch: "blocked", write: "blocked", spawn: "blocked", read: "blocked", temp: "written" } })
    expect(existsSync(escape)).toBe(false)
  }, 20_000)

  test("a script that runs over its memory limit is stopped; a syntax error or a throw comes back as the error", async () => {
    expect(await run("const all = []; while (true) all.push(new Array(1e6).fill(1))")).toEqual({ error: "the script went over 512 MB and was stopped" })
    expect((await run("return {")).error).toContain("Unexpected end of file")
    expect((await run(`console.log("seen"); throw new Error("boom")`))).toMatchObject({ error: expect.stringContaining("boom"), logs: "seen" })
  }, 20_000)
})

/** A recipe chef with one tool (gmail's sender_history; the scripted model never calls it) and the widget chef, which has none. */
const lookup = {
  id: "lookup",
  purpose: "Say whether a sender is known.",
  agent: { model: "test/m", candidates: ["test/m"], system: "You look senders up." },
  events: { "lookup.requested": { address: "string" }, "lookup.ready": { known: "boolean" } },
  job: {
    id: "look",
    description: "Look the sender up.",
    input: "lookup.requested",
    triggers: ["manual"],
    prompt: "{{address}}",
    tools: ["gmail.sender_history"],
    codeExample: "const history = await sender_history({ address: \"<address>\" })\nreturn \"error\" in history ? history : history.messages_from",
    answer: { known: "boolean" },
    output: "lookup.ready"
  }
}

describe("tool mode per chef", () => {
  test("config.json switches a chef's tool mode live: the next run's model gets run_code over typed functions, job.started records the mode, and the change's undo puts tools back", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const dir = yield* builtinChefs(root, ["widget"])
      yield* Effect.promise(() => Bun.write(`${dir}/lookup.json`, JSON.stringify(lookup)))
      const seen = yield* Ref.make<ReadonlyArray<GenerateRequest>>([])
      const models = ModelRunner.of({
        generate: (request) =>
          Ref.update(seen, (all) => [...all, request]).pipe(Effect.as({ text: JSON.stringify({ answer: { known: true } }), model: request.model, provider: "test", seconds: 0, cost: 0 }))
      })
      yield* Effect.gen(function*() {
        const runner = yield* Runner
        const settings = yield* Settings
        const bus = yield* EventBus
        const look = (options: { readonly toolMode?: "code" } = {}) => Effect.gen(function*() {
          const { run } = yield* runner.run("lookup", "look", { address: "a@b.c" }, options)
          const started = (yield* bus.history).flatMap((event) => event.run === run ? Option.toArray(lifecycle(event)) : [])[0]
          return { started, system: (yield* Ref.get(seen)).at(-1)!.system }
        })

        const before = yield* look()
        expect(before.started).toMatchObject({ _tag: "job.started", toolMode: "tools" })
        expect(before.system).not.toContain("run_code")

        const changes = yield* settings.set({ components: { lookup: { toolMode: "code" } } }, "tester", "use")
        const code = yield* look()
        expect(code.started).toMatchObject({ _tag: "job.started", toolMode: "code" })
        expect(code.system).toContain("run_code")
        expect(code.system).toContain(
          "declare function sender_history(args: { address: string }): Promise<{ address: string; messages_from: number; from_last_90_days: number; isaac_wrote_to_them: number; starred_from: number; recent: Array<{ date: string; subject: string }> } | { error: string }>"
        )
        expect(code.system).toContain("history.messages_from")

        // The undo patch config.changed carries (here applied directly; as a config.set event it is the same call).
        const changed = (yield* bus.history).filter((event) => event.type === "atomic-agents/config.changed").at(-1)!.data as { undo: Record<string, Schema.Json> }
        expect(changes.map((change) => change.path.join("."))).toEqual(["components.lookup.toolMode"])
        yield* settings.set(changed.undo, "tester", "set")
        const undone = yield* look()
        expect(undone.started).toMatchObject({ toolMode: "tools" })

        // A bake-off arm overrides the mode for one run; a chef without tools has no tool mode, in config or as an override.
        const arm = yield* look({ toolMode: "code" })
        expect(arm.started).toMatchObject({ toolMode: "code" })
        expect(arm.system).toContain("run_code")
        const refused = yield* settings.set({ components: { widget: { toolMode: "code" } } }, "tester", "use").pipe(Effect.flip)
        expect(refused.message).toContain("widget.toolMode: widget calls no tools, so it has no tool mode")
        expect((yield* runner.run("widget", "pick", {}, { toolMode: "code" }).pipe(Effect.flip))._tag).toBe("NoToolMode")
      }).pipe(Effect.provide(runtime(root, { dirs: [dir] }, models)))
    }).pipe(Effect.scoped, Effect.runPromise), 30_000)

  test("a chef with tools must ship a code example, so it can run either mode", () =>
    Effect.gen(function*() {
      const root = yield* tempHome
      const { codeExample: _, ...job } = lookup.job
      const error = yield* parseChef(`${root}/lookup.json`, JSON.stringify({ ...lookup, job })).pipe(Effect.flip, Effect.provide(oneProcess(root)))
      expect(error.message).toContain("job.codeExample: a chef with job.tools needs one")
    }).pipe(Effect.scoped, Effect.runPromise))
})
