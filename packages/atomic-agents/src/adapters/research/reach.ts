import { Context, Effect, Layer, Option, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { exec } from "../../exec.ts"
import { fetchText, type Hit, mcpCall, type Page, ResearchError } from "./http.ts"

/** agent-reach's web search: Exa's keyless MCP (`mcporter call exa.web_search_exa` in the skill). */
const EXA_MCP = "https://mcp.exa.ai/mcp"
/** agent-reach's page reader. */
const JINA = "https://r.jina.ai/"

export const PLATFORMS = ["github", "youtube", "reddit", "x", "xiaohongshu", "instagram", "facebook", "marketplace"] as const
export type Platform = typeof PLATFORMS[number]
export type GithubKind = "repos" | "issues" | "code"

/**
 * Hosts per platform (and a path prefix where the platform is part of a site). On this Mac only GitHub (gh)
 * has its own agent-reach backend that works: reddit.com and x.com fail TLS on the network, twitter-cli with
 * them, and Reddit and Xiaohongshu have no logged-in backend installed (`agent-reach doctor`). Those
 * platforms, and Instagram, Facebook and Marketplace when Muse could not answer, go through Exa's index,
 * kept to results on the platform's own pages.
 */
const HOSTS: Readonly<Record<Exclude<Platform, "github">, { readonly hosts: ReadonlyArray<string>; readonly path?: string }>> = {
  youtube: { hosts: ["youtube.com", "youtu.be"] },
  reddit: { hosts: ["reddit.com"] },
  x: { hosts: ["x.com", "twitter.com"] },
  xiaohongshu: { hosts: ["xiaohongshu.com", "xhslink.com"] },
  instagram: { hosts: ["instagram.com"] },
  facebook: { hosts: ["facebook.com", "fb.com"] },
  marketplace: { hosts: ["facebook.com"], path: "/marketplace" }
}

const NAMES: Readonly<Partial<Record<Platform, string>>> = { x: "X/Twitter posts", marketplace: "Facebook Marketplace listings" }

const onPlatform = (url: string, { hosts, path }: typeof HOSTS[keyof typeof HOSTS]) => {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  const host = parsed.hostname.replace(/^www\.|^m\.|^old\.|^web\./, "")
  return hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`)) && (path === undefined || parsed.pathname.startsWith(path))
}

/** Exa's text answer: `Title: / URL: / Published: / Highlights:` blocks between `---` lines. */
const parseExa = (text: string): ReadonlyArray<Hit> =>
  text.split(/\n-{3,}\n/).flatMap((block) => {
    const field = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(block)?.[1]?.trim()
    const url = field("URL")
    if (url === undefined || !URL.canParse(url)) return []
    const highlights = block.indexOf("Highlights:")
    const date = field("Published")
    return [{
      url,
      title: field("Title") ?? "",
      ...(date !== undefined && date !== "N/A" ? { date } : {}),
      text: (highlights < 0 ? block : block.slice(highlights + "Highlights:".length)).trim()
    }]
  })

const GhRepo = Schema.Struct({ fullName: Schema.String, description: Schema.NullOr(Schema.String), url: Schema.String, stargazersCount: Schema.Number, updatedAt: Schema.String })
const GhIssue = Schema.Struct({ title: Schema.String, url: Schema.String, state: Schema.String, createdAt: Schema.String, body: Schema.NullOr(Schema.String), repository: Schema.Struct({ nameWithOwner: Schema.String }) })
const GhCode = Schema.Struct({ path: Schema.String, url: Schema.String, repository: Schema.Struct({ nameWithOwner: Schema.String }), textMatches: Schema.Array(Schema.Struct({ fragment: Schema.String })) })
const GH_FIELDS: Readonly<Record<GithubKind, string>> = {
  repos: "fullName,description,url,stargazersCount,updatedAt",
  issues: "title,url,state,createdAt,body,repository",
  code: "path,url,repository,textMatches"
}
const decodeGh = {
  repos: Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(GhRepo))),
  issues: Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(GhIssue))),
  code: Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(GhCode)))
}

/**
 * The agent-reach routes, split out of the skill as read-only sources: its web search (Exa) and reader
 * (Jina, then Exa's fetch) as the fallback when the primary source comes up thin, and the per-platform
 * routes (GitHub through `gh search`; YouTube, Reddit, X and Xiaohongshu through Exa on their hosts).
 */
export class Reach extends Context.Service<Reach, {
  search(query: string, objective: string): Effect.Effect<ReadonlyArray<Hit>, ResearchError>
  read(url: string): Effect.Effect<Page, ResearchError>
  platform(platform: Platform, query: string, kind: GithubKind): Effect.Effect<ReadonlyArray<Hit>, ResearchError>
}>()("atomic-agents/research/Reach") {
  static readonly layer = Layer.effect(
    Reach,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const exa = (query: string, objective: string, results: number) =>
        mcpCall(EXA_MCP, "web_search_exa", { query, objective, numResults: results }).pipe(Effect.map(parseExa))
      const exaFetch = (url: string) =>
        mcpCall(EXA_MCP, "web_fetch_exa", { urls: [url], maxCharacters: 50_000 }).pipe(Effect.flatMap((text) =>
          /^Error fetching/i.test(text.trim()) || text.trim().length < 80
            ? Effect.fail(new ResearchError({ message: `exa fetch ${url}: ${text.trim().slice(0, 200)}` }))
            : Effect.succeed(text)))
      const jina = (url: string) =>
        fetchText(`${JINA}${url}`, { headers: { "x-no-cache": "true" } }).pipe(Effect.flatMap((text) => {
          // Jina answers 200 with the target's error page inside; a 4xx/5xx target is a failed read.
          const blocked = /^Warning: Target URL returned error (\d+)/m.exec(text)
          const content = text.indexOf("Markdown Content:")
          const body = content < 0 ? text : text.slice(content + "Markdown Content:".length)
          return blocked !== null || body.trim().length < 80
            ? Effect.fail(new ResearchError({ message: `jina ${url}: ${blocked === null ? "empty page" : `target answered ${blocked[1]}`}` }))
            : Effect.succeed(text)
        }))
      const read = Effect.fn("Reach.read")(function*(url: string) {
        const text = yield* jina(url).pipe(
          Effect.catch((first) => exaFetch(url).pipe(Effect.mapError((second) => new ResearchError({ message: `${first.message}; ${second.message}` }))))
        )
        return { url, text } satisfies Page
      })
      const github = Effect.fn("Reach.github")(function*(query: string, kind: GithubKind) {
        const result = yield* exec("gh", ["search", kind, query, "--limit", "6", "--json", GH_FIELDS[kind]]).pipe(
          Effect.timeoutOrElse({ duration: "45 seconds", orElse: () => Effect.fail(new ResearchError({ message: `gh search ${kind}: timed out` })) }),
          Effect.catchTag("PlatformError", (error) => Effect.fail(new ResearchError({ message: `gh search ${kind}: ${error.message}` }))),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
        )
        if (result.exitCode !== 0) return yield* new ResearchError({ message: `gh search ${kind}: ${result.stderr.trim().slice(0, 300)}` })
        const unreadable = new ResearchError({ message: `gh search ${kind}: unreadable output` })
        if (kind === "repos") {
          return yield* Option.match(decodeGh.repos(result.stdout), {
            onNone: () => Effect.fail(unreadable),
            onSome: (repos) => Effect.succeed(repos.map((repo): Hit => ({ url: repo.url, title: repo.fullName, date: repo.updatedAt, text: `${repo.description ?? ""} (${repo.stargazersCount} stars)` })))
          })
        }
        if (kind === "issues") {
          return yield* Option.match(decodeGh.issues(result.stdout), {
            onNone: () => Effect.fail(unreadable),
            onSome: (issues) => Effect.succeed(issues.map((issue): Hit => ({ url: issue.url, title: `${issue.repository.nameWithOwner}: ${issue.title} (${issue.state})`, date: issue.createdAt, text: (issue.body ?? "").slice(0, 1500) })))
          })
        }
        return yield* Option.match(decodeGh.code(result.stdout), {
          onNone: () => Effect.fail(unreadable),
          onSome: (files) => Effect.succeed(files.map((file): Hit => ({ url: file.url, title: `${file.repository.nameWithOwner}/${file.path}`, text: file.textMatches.map((match) => match.fragment).join("\n...\n") })))
        })
      })
      const platform = Effect.fn("Reach.platform")(function*(name: Platform, query: string, kind: GithubKind) {
        if (name === "github") return yield* github(query, kind)
        const label = NAMES[name] ?? `${name} posts`
        const hits = yield* exa(`${query} (${label})`, `${label} about: ${query}`, 15)
        return hits.filter((hit) => onPlatform(hit.url, HOSTS[name])).slice(0, 6)
      })
      return Reach.of({ search: (query, objective) => exa(query, objective, 8), read, platform })
    })
  )
}
