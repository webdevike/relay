import { BunServices } from "@effect/platform-bun"
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { Effect, Schema } from "effect"
import { toolAdapter } from "../src/Adapter.ts"
import { codeTool } from "../src/CodeMode.ts"

const echo = toolAdapter({
  name: "test.echo",
  description: "Echoes its text.",
  args: Schema.Struct({ text: Schema.String }),
  example: `{"text": "<text>"}`,
  returns: "{ text: string; caller: string }",
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
