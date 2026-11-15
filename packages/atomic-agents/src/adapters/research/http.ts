import { Effect, Schema } from "effect"

export class ResearchError extends Schema.TaggedError<ResearchError>()("ResearchError", {
  message: Schema.String
}) {}

/** What a search returns per result: the text is the engine's excerpt or highlight of the page. */
export interface Hit {
  readonly url: string
  readonly title: string
  readonly date?: string
  readonly text: string
}

/** A page as a reader returned it, markdown or plain text. */
export interface Page {
  readonly url: string
  readonly text: string
}

const Rpc = Schema.Struct({
  result: Schema.optional(Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
    isError: Schema.optional(Schema.Boolean)
  })),
  error: Schema.optional(Schema.Struct({ message: Schema.String }))
})
const decodeRpc = Schema.decodeUnknownOption(Schema.fromJsonString(Rpc))

const failure = (message: string) => new ResearchError({ message })

/** GET or POST `url`, the body as text; a non-2xx answer is a failure naming the status. */
export const fetchText = (url: string, init: RequestInit = {}, timeout = 45_000) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) })
      const body = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`)
      return body
    },
    catch: (error) => failure(`${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`)
  })

/**
 * One `tools/call` on a public, keyless MCP endpoint over streamable HTTP (stateless: no session, no
 * initialize). Answers the tool's text content; a JSON-RPC error or `isError` result is a failure.
 */
export const mcpCall = (endpoint: string, tool: string, args: Readonly<Record<string, unknown>>) =>
  fetchText(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } })
  }).pipe(Effect.flatMap((body) => {
    // Plain JSON, or an SSE stream whose last `data:` line is the response.
    const json = body.trimStart().startsWith("{") ? body : body.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).at(-1) ?? ""
    const rpc = decodeRpc(json)
    if (rpc._tag === "None") return Effect.fail(failure(`${tool}: unreadable MCP response ${body.slice(0, 200)}`))
    const { result, error } = rpc.value
    if (error !== undefined) return Effect.fail(failure(`${tool}: ${error.message}`))
    const text = (result?.content ?? []).flatMap((part) => part.type === "text" && part.text !== undefined ? [part.text] : []).join("\n")
    return result?.isError === true ? Effect.fail(failure(`${tool}: ${text.slice(0, 300)}`)) : Effect.succeed(text)
  }))
