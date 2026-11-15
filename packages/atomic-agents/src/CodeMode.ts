import { Effect, Fiber, FileSystem, Schema } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { existsSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { shortName, type ToolAdapter } from "./Adapter.ts"
import { type Tool, tool } from "./Model.ts"

/**
 * Code mode (tool mode `code`, after Cloudflare's Code Mode and Anthropic's code execution with MCP): instead of one
 * tool call per model turn, the model gets one tool, `run_code`, and writes a TypeScript script against the job's tools
 * as typed async functions, generated from each tool adapter's `args` and `returns` schemas, so any chef's tools are a
 * typed API with no per-chef code. The script can run calls side by side, filter what comes back and return only what
 * the answer needs. Every function call comes back to this process over IPC and runs the real tool adapter on the item's
 * fields (`caller` "script"), so a pack's gates, ledgers and checks hold exactly as in tool mode `tools`.
 *
 * The script runs in a fresh Bun process under macOS `sandbox-exec`: no network, no other process, no reads under
 * the home directory except Bun's own, writes only in its temp dir, a time and a memory limit.
 * When to use which mode: `docs/code-mode.md`.
 */
export const CODE_TOOL = "run_code"
/** A script's wall time: room for a Muse ask (about a minute, and asks queue one at a time across the service) plus reads. */
const SECONDS = 240
const MEMORY_MB = 512
const RESULT_CHARS = 5000
const LOG_CHARS = 1000
const SANDBOX_EXEC = "/usr/bin/sandbox-exec"

type JsonSchema = { readonly [key: string]: unknown }

/** A JSON Schema (as `Schema.toJsonSchemaDocument` writes one) as a TypeScript type. */
const tsType = (schema: JsonSchema, definitions: JsonSchema): string => {
  if (typeof schema["$ref"] === "string") return tsType((definitions[schema["$ref"].split("/").at(-1)!] ?? {}) as JsonSchema, definitions)
  if (Array.isArray(schema["enum"])) return schema["enum"].map((value) => JSON.stringify(value)).join(" | ")
  // `Schema.Struct({})`, a tool with no args, is "anything but null".
  if ((schema["not"] as JsonSchema | undefined)?.["type"] === "null") return "{}"
  if ("const" in schema) return JSON.stringify(schema["const"])
  const union = schema["anyOf"] ?? schema["oneOf"]
  if (Array.isArray(union)) return union.map((member) => tsType(member as JsonSchema, definitions)).join(" | ")
  switch (schema["type"]) {
    case "string":
      return "string"
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "null":
      return "null"
    case "array":
      return `Array<${tsType((schema["items"] ?? {}) as JsonSchema, definitions)}>`
    case "object": {
      const required = new Set(Array.isArray(schema["required"]) ? schema["required"] : [])
      const properties = Object.entries((schema["properties"] ?? {}) as Record<string, JsonSchema>)
      return properties.length === 0
        ? "Record<string, unknown>"
        : `{ ${properties.map(([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${tsType(value, definitions)}`).join("; ")} }`
    }
  }
  return "unknown"
}

/** A schema as a TypeScript type, through its JSON Schema document. */
const typeOf = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema)
  return tsType(document.schema as JsonSchema, document.definitions as JsonSchema)
}

/** The tools as the script's typed functions, one declaration each under its description. */
export const declarations = (tools: ReadonlyArray<ToolAdapter>) =>
  tools.map((candidate) =>
    `/** ${candidate.description} */\ndeclare function ${shortName(candidate.name)}(args: ${typeOf(candidate.args as Schema.Top)}): Promise<${typeOf(candidate.returns)}>`
  ).join("\n")

/** The child's side: the tools as functions over IPC, the script's default export called with them, its value sent back. */
const RUNNER = `
const pending = new Map()
let next = 0
process.on("message", (message) => {
  if (message.exit) process.exit(0)
  const waiting = pending.get(message.id)
  if (waiting === undefined) return
  pending.delete(message.id)
  if (message.error === undefined) waiting.resolve(message.value)
  else waiting.reject(new Error(message.error))
})
const api = new Proxy({}, { get: (_, name) => (args) => {
  const id = next++
  const waiting = Promise.withResolvers()
  pending.set(id, waiting)
  process.send({ id, name: String(name), args })
  return waiting.promise
} })
try {
  // Imported at run time so a syntax error in the script comes back as its error, not a crashed runner.
  const { default: main } = await import("./script.ts")
  const value = await main(api)
  process.send({ done: true, value: value === undefined ? null : value })
} catch (error) {
  process.send({ done: true, error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
}
`

const profile = (dir: string, bun: string) => `(version 1)
(allow default)
(deny network*)
(deny process-exec*)
(allow process-exec* (literal "${bun}"))
(deny file-write*)
(allow file-write* (subpath "${dir}") (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))
(deny file-read* (subpath "${process.env["HOME"] ?? "/Users"}"))
(allow file-read* (subpath "${dirname(bun)}") (subpath "${dir}"))
`

/** A stream's text, at most `max` characters kept, the rest drained so the child never blocks on a full pipe. */
const collect = async (stream: ReadableStream<Uint8Array>, max: number) => {
  const decoder = new TextDecoder()
  let text = ""
  for await (const chunk of stream) if (text.length <= max) text += decoder.decode(chunk, { stream: true })
  return text.length > max ? `${text.slice(0, max)}... (cut at ${max} characters)` : text
}

interface Outcome {
  readonly value?: unknown
  readonly error?: string
  readonly logs: string
}

interface Message {
  readonly id?: number
  readonly name?: string
  readonly args?: unknown
  readonly done?: boolean
  readonly value?: unknown
  readonly error?: string
}

/** Run one script in the sandbox; every way it can end (a throw, a crash, a limit) is an outcome, never a failure. */
const runScript = (code: string, tools: ReadonlyArray<ToolAdapter>, fields: Readonly<Record<string, unknown>>) =>
  Effect.scoped(Effect.gen(function*() {
    if (!existsSync(SANDBOX_EXEC)) return { error: `code mode needs macOS ${SANDBOX_EXEC}, which this host lacks`, logs: "" } satisfies Outcome
    const fs = yield* FileSystem.FileSystem
    const dir = realpathSync(yield* fs.makeTempDirectoryScoped({ prefix: "atomic-code-" }))
    const bun = realpathSync(process.execPath)
    const byName = new Map(tools.map((candidate) => [shortName(candidate.name), candidate]))
    yield* fs.writeFileString(join(dir, "script.ts"), `export default async function ({ ${[...byName.keys()].join(", ")} }: Record<string, (args: unknown) => Promise<any>>) {\n${code}\n}\n`)
    yield* fs.writeFileString(join(dir, "runner.ts"), RUNNER)
    yield* fs.writeFileString(join(dir, "sandbox.sb"), profile(dir, bun))
    const services = yield* Effect.context<BunServices>()
    const call = (name: string, args: unknown) => {
      const found = byName.get(name)
      if (found === undefined) return Effect.succeed({ error: `no function ${name}; there are ${[...byName.keys()].join(", ")}` })
      return Schema.decodeUnknownEffect(found.args)(args ?? {}).pipe(
        Effect.mapError((error) => ({ message: `bad args for ${name}: ${error.message}` })),
        Effect.flatMap((decoded) => found.run(decoded, fields, "script")),
        Effect.map((value) => ({ value })),
        Effect.catch((error) => Effect.succeed({ error: error.message }))
      )
    }
    return yield* Effect.callback<Outcome>((resume) => {
      let done: { readonly value?: unknown; readonly error?: string } | undefined
      let limit: string | undefined
      const calls = new Set<Fiber.Fiber<unknown>>()
      const child = Bun.spawn([SANDBOX_EXEC, "-f", join(dir, "sandbox.sb"), bun, join(dir, "runner.ts")], {
        cwd: dir,
        env: { PATH: "/usr/bin:/bin", HOME: dir, TMPDIR: dir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", NO_COLOR: "1" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        serialization: "json",
        ipc(raw, subprocess) {
          const message = raw as Message
          if (message.done === true) {
            done = message.error === undefined ? { value: message.value } : { error: message.error }
            subprocess.send({ exit: true })
            setTimeout(() => subprocess.kill(9), 2000)
            return
          }
          if (typeof message.id !== "number" || typeof message.name !== "string") return
          const fiber = Effect.runForkWith(services)(call(message.name, message.args).pipe(Effect.tap((reply) =>
            Effect.sync(() => {
              if (subprocess.exitCode === null && subprocess.signalCode === null) subprocess.send({ id: message.id, ...reply })
            }))))
          calls.add(fiber)
          fiber.addObserver(() => calls.delete(fiber))
        }
      })
      const stop = (reason: string) => {
        limit ??= reason
        child.kill(9)
      }
      const deadline = setTimeout(() => stop(`ran over ${SECONDS} s`), SECONDS * 1000)
      const memory = setInterval(() => {
        const rss = Number(Bun.spawnSync(["ps", "-o", "rss=", "-p", String(child.pid)]).stdout.toString().trim()) * 1024
        if (rss > MEMORY_MB * 1024 * 1024) stop(`went over ${MEMORY_MB} MB`)
      }, 500)
      const logs = collect(child.stdout, LOG_CHARS)
      const errors = collect(child.stderr, 2000)
      const settle = () => {
        clearTimeout(deadline)
        clearInterval(memory)
        for (const fiber of calls) Effect.runFork(Fiber.interrupt(fiber))
      }
      void child.exited.then(async () => {
        settle()
        const [out, err] = await Promise.all([logs, errors])
        const ended = done !== undefined
          ? done
          : { error: limit !== undefined ? `the script ${limit} and was stopped` : `the script exited without returning: ${err.trim().slice(-800) || `exit ${child.exitCode}`}` }
        resume(Effect.succeed({ ...ended, logs: out.trim() }))
      })
      return Effect.sync(() => {
        settle()
        child.kill(9)
      })
    })
  }))

/** What the model sees of a script's run: its value (cut, with a note, past RESULT_CHARS) or its error, and its logs. */
const shown = (outcome: Outcome) => {
  const logs = outcome.logs === "" ? {} : { logs: outcome.logs }
  if (outcome.error !== undefined) return { error: outcome.error, ...logs }
  const json = JSON.stringify(outcome.value) ?? "null"
  return json.length <= RESULT_CHARS
    ? { result: outcome.value, ...logs }
    : { result: json.slice(0, RESULT_CHARS), note: `cut at ${RESULT_CHARS} of ${json.length} characters: return less (only the passages you need, each with its url)`, ...logs }
}

/**
 * The one tool a code-mode job's model gets: a script over `tools`, which run on the item's `fields`. `example` is the
 * job's `codeExample` (a script showing the pattern the chef wants); without one, a single call whose result is trimmed.
 */
export const codeTool = (tools: ReadonlyArray<ToolAdapter>, fields: Readonly<Record<string, unknown>>, example?: string): Tool<BunServices> => {
  const first = tools[0]
  return tool({
    name: CODE_TOOL,
    description: [
      `Runs a TypeScript script: the body of an async function with these read-only functions in scope. They are functions inside the script, not tools: ${CODE_TOOL} is your only tool. Each is one call to the tool of that name; a failure or a closed gate throws an Error with the tool's message.`,
      "```ts",
      declarations(tools),
      "```",
      `\`return\` a JSON value with only what you need (the passages or facts, each with its url), at most ${RESULT_CHARS} characters; console.log output shows too (first ${LOG_CHARS} characters). Run independent calls at once with Promise.all, and cut long text down with regex and string methods before you return it.`,
      `Sandbox: no network or files except through these functions, ${SECONDS} s, ${MEMORY_MB} MB. Nothing carries over between scripts, so return what you need.`
    ].join("\n"),
    args: Schema.Struct({ code: Schema.NonEmptyString }),
    example: JSON.stringify({
      code: example ?? (first === undefined ? "return 1" : `const r = await ${shortName(first.name)}(${first.example})\nreturn JSON.stringify(r).slice(0, 2000)`)
    }),
    run: ({ code }) => Effect.map(runScript(code, tools, fields), shown)
  })
}
