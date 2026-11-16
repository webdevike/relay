import { Context, Effect, Layer, Option, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { exec } from "../../../src/core/exec.ts"
import { type Hit, mcpCall, type Page, ResearchError } from "./http.ts"

/** omp's first web search engine (`web/parallel`), through its credential-free MCP endpoint. */
const PARALLEL_MCP = "https://search.parallel.ai/mcp"

const Results = Schema.Struct({
  results: Schema.Array(Schema.Struct({
    url: Schema.String,
    title: Schema.optional(Schema.NullOr(Schema.String)),
    publish_date: Schema.optional(Schema.NullOr(Schema.String)),
    excerpts: Schema.optional(Schema.NullOr(Schema.Array(Schema.String)))
  }))
})
const decodeResults = Schema.decodeUnknownOption(Schema.fromJsonString(Results))

/** Under this many characters a read is a failure: a login wall, a blocked page, an empty shell. */
const EMPTY_PAGE = 80
/** A page whose text outside links, images and tables is under this many characters, and under a fifth of the page, is navigation only. */
const NAV_TEXT = 400

/**
 * True when the page's text outside front matter, links, images, tables and markup is short, alone and
 * against the page: a forum thread whose posts did not load (bitcointalk.org topic 137 reads as 5,010
 * characters, 186 of them text) is navigation only, and its read fails so agent-reach's reader opens.
 */
export const navOnly = (page: string) => {
  const text = page
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, " ")
    .replace(/[|*_#>`[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return text.length < NAV_TEXT && text.length * 5 < page.length
}

/**
 * The primary source: a plain web search (Parallel, omp's default first engine) and omp's own page
 * reader (`omp read <url>`: markdown alternates, PDFs, GitHub issues and READMEs through the API,
 * YouTube transcripts). Read-only; nothing here signs in anywhere.
 */
export class Web extends Context.Service<Web, {
  search(objective: string, queries: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<Hit>, ResearchError>
  read(url: string): Effect.Effect<Page, ResearchError>
}>()("atomic-agents/research/Web") {
  static readonly layer = Layer.effect(
    Web,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const search = Effect.fn("Web.search")(function*(objective: string, queries: ReadonlyArray<string>) {
        const text = yield* mcpCall(PARALLEL_MCP, "web_search", { objective, search_queries: queries })
        const results = Option.getOrUndefined(decodeResults(text))
        if (results === undefined) return yield* new ResearchError({ message: `web search: unreadable results ${text.slice(0, 200)}` })
        return results.results.map((result): Hit => ({
          url: result.url,
          title: result.title ?? "",
          ...(result.publish_date ? { date: result.publish_date } : {}),
          text: (result.excerpts ?? []).join("\n")
        }))
      })
      const read = Effect.fn("Web.read")(function*(url: string) {
        // Without a line range omp read stops at 300 lines; with one it stops at 50 KB.
        const result = yield* exec("omp", ["read", `${url}:1-100000`]).pipe(
          Effect.timeoutOrElse({ duration: "90 seconds", orElse: () => Effect.fail(new ResearchError({ message: `read ${url}: timed out` })) }),
          Effect.catchTag("PlatformError", (error) => Effect.fail(new ResearchError({ message: `read ${url}: ${error.message}` }))),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
        )
        // `URL: ...`, `Method: ...`, `Notes: ...` header lines, `---`, then the page.
        const split = result.stdout.indexOf("\n---\n")
        const header = split < 0 ? result.stdout : result.stdout.slice(0, split)
        const body = split < 0 ? "" : result.stdout.slice(split + 5).replace(/\n\[Showing lines [^\n]*\]\s*$/, "").trim()
        if (result.exitCode !== 0 || /^Method: failed$/m.test(header)) {
          const notes = /^Notes: (.*)$/m.exec(header)?.[1] ?? (result.stderr.trim().slice(-200) || `exit ${result.exitCode}`)
          return yield* new ResearchError({ message: `read ${url}: ${notes}` })
        }
        if (body.length < EMPTY_PAGE) return yield* new ResearchError({ message: `read ${url}: the page came back empty` })
        if (navOnly(body)) return yield* new ResearchError({ message: `read ${url}: only the site's navigation came back, not its content` })
        return { url, text: body } satisfies Page
      })
      return Web.of({ search, read })
    })
  )
}
