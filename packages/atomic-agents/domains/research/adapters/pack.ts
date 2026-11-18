import { Effect, Layer, Option, Schema } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { type Caller, pack, toolAdapter } from "../../../src/core/Adapter.ts"
import type { ToolsError } from "../../../src/core/Component.ts"
import { type Hit, ResearchError } from "./http.ts"
import { MUSE_PLATFORMS, type MusePlatform, Muse } from "./muse.ts"
import { type GithubKind, type Platform, PLATFORMS, Reach } from "./reach.ts"
import { schemas } from "../schema.ts"
import { Web } from "./web.ts"

/**
 * The research sources as adapters, with the split the web-researcher agent runs on:
 * - primary: `web.search` (plain web search) and `web.read` (page reader), always first;
 * - agent-reach fallback: `reach.fallback_search` opens once the primary search failed, came back
 *   thin (under 3 results) or ran twice; `reach.fallback_read` opens for a URL `web.read` could not read;
 * - agent-reach platforms: `reach.platform_search`, only for platforms the request names;
 * - Muse (Meta AI in Muse's desktop app, signed in as Isaac): `muse.social_search`, for Instagram, Facebook
 *   and Marketplace, the platforms only it sees into. When the request names one, Muse goes first; agent-reach
 *   (its platform route and its fallback search) opens only after Muse failed or found nothing. Muse is a
 *   secondary source: a quote is checked on the linked page when that opens, on Muse's own words only when not.
 * The gates are enforced here, not left to the prompt. What each item's tools ran and showed is kept in a
 * ledger, so the `research.citations` check can verify quotes and say which source every answer used.
 */

/** Under this many results a primary search is thin and opens the fallback. */
const THIN = 3
/** Primary searches after which the fallback opens even when each one came back full. */
const SEARCHES_BEFORE_FALLBACK = 2
/** Characters of one tool result the model sees (the tool loop caps a result at 6000, JSON escapes included). */
const SHOWN = 4500
/**
 * Longest passage `find` scores on its own. A longer paragraph is cut into pieces (Jina reads a whole
 * bitcointalk thread as one 30k-character paragraph), so a match deep in it still fits the window.
 */
const PIECE = 1500
const EXCERPT = 600
/** A quote shorter than this proves nothing ("engine unity", from a press kit, is about the shortest that still does). */
const MIN_QUOTE = 12

type Route = "primary" | "muse" | "platform" | "fallback"
const ROUTE: Readonly<Record<string, Route>> = {
  "web.search": "primary",
  "web.read": "primary",
  "web.screenshot": "primary",
  "muse.social_search": "muse",
  "reach.platform_search": "platform",
  "reach.fallback_search": "fallback",
  "reach.fallback_read": "fallback"
}

interface Source {
  /** The adapter that first showed this URL. */
  readonly via: string
  /** Normalized text of the page as a reader returned it. */
  page?: string
  /** Normalized search excerpts of it. */
  readonly excerpts: Array<string>
  /** Normalized words Muse said about this link (its secondary account of the page). */
  readonly muse: Array<string>
}

/** One item's research so far (its first answer and the repair turn included). */
interface Ledger {
  readonly calls: Map<string, number>
  primarySearches: number
  primaryThin: boolean
  readonly unreadable: Set<string>
  readonly sources: Map<string, Source>
  /** What Muse did per platform asked: answered with links, answered without any, or failed. */
  readonly muse: Map<MusePlatform, "answered" | "empty" | "failed">
}

/**
 * Ledgers by the item's fields object: the agent spec hands the same object to every tool call and to the
 * check of one item (`AgentSpec.ts` item), and a new one per item, so a ledger lives exactly as long as its item.
 */
const ledgers = new WeakMap<object, Ledger>()
const ledgerOf = (fields: object) => {
  const found = ledgers.get(fields)
  if (found !== undefined) return found
  const fresh: Ledger = { calls: new Map(), primarySearches: 0, primaryThin: false, unreadable: new Set(), sources: new Map(), muse: new Map() }
  ledgers.set(fields, fresh)
  return fresh
}

/** One URL however a tool or the model writes it: no scheme, `www.`, fragment or trailing slash. */
const urlKey = (url: string) =>
  url.trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase()

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " " }

/**
 * Text as a quote is compared: markdown and HTML dropped, quotes, dashes, case and whitespace folded.
 * Only a real tag goes (`<` then a tag name, no `<` or `>` inside): code like `1<<24` or `a < b` stays.
 */
const normalize = (text: string) =>
  text.normalize("NFKC")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?:\s[^<>]*)?\/?>/gi, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\\([^\w\s])/g, "$1")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, "\"")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[*_`#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

/** The quote's spans (split at `...`), each found in normalized `text`, in order. */
const quoteIn = (quote: string, text: string) => {
  const spans = quote.split(/\.\.\.|\u2026/).map((span) => normalize(span).replace(/^["']+|["']+$/g, "").trim()).filter((span) => span.length > 0)
  let from = 0
  for (const span of spans) {
    const at = text.indexOf(span, from)
    if (at < 0) return false
    from = at + span.length
  }
  return spans.length > 0
}

const remember = (ledger: Ledger, via: string, url: string, page: string | undefined, excerpt: string | undefined) => {
  const key = urlKey(url)
  const source = ledger.sources.get(key) ?? { via, excerpts: [], muse: [] }
  if (page !== undefined) source.page = normalize(page)
  if (excerpt !== undefined && excerpt !== "") source.excerpts.push(normalize(excerpt))
  ledger.sources.set(key, source)
}

const counted = (ledger: Ledger, name: string) => ledger.calls.set(name, (ledger.calls.get(name) ?? 0) + 1)

/** A search's hits as the caller gets them: the model an excerpt of each, a script (code mode) the whole text; the ledger keeps all of it. */
const shown = (ledger: Ledger, via: string, hits: ReadonlyArray<Hit>, caller: Caller) => {
  for (const hit of hits) remember(ledger, via, hit.url, undefined, hit.text)
  return hits.map((hit) => ({ url: hit.url, title: hit.title, ...(hit.date ? { date: hit.date } : {}), ...(caller === "model" ? { excerpt: hit.text.slice(0, EXCERPT) } : { text: hit.text }) }))
}
const HITS = Schema.Struct({
  results: Schema.Array(Schema.Struct({ url: Schema.String, title: Schema.String, date: Schema.optionalKey(Schema.String), text: Schema.String })),
  note: Schema.optionalKey(Schema.String)
})

/**
 * `find`'s terms: each word of 3+ letters, found inside longer words too ("goroutine" in "goroutines"),
 * and each short or symbol-bearing token as typed ("q=0.30", "z=24", "1<<24", "Go"), found only whole.
 */
const terms = (find: string): ReadonlyArray<(body: string) => boolean> => {
  const lower = find.toLowerCase()
  const words = new Set(lower.split(/\W+/).filter((word) => word.length >= 3))
  const tokens = new Set(lower.split(/\s+/).map((token) => token.replace(/^["'(\[]+|["'),.;:!?\]]+$/g, "")).filter((token) => token !== "" && (token.length < 3 || /\W/.test(token))))
  return [
    ...[...words].map((word) => (body: string) => body.includes(word)),
    ...[...tokens].map((token) => {
      const whole = new RegExp(`${/^\w/.test(token) ? "(?<!\\w)" : ""}${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${/\w$/.test(token) ? "(?!\\w)" : ""}`)
      return (body: string) => whole.test(body)
    })
  ]
}

interface Span {
  readonly start: number
  readonly end: number
}

/** The text's paragraphs as [start, end) offsets: blank lines, and line breaks before a heading or list item, part them. */
const paragraphs = (text: string) => {
  const spans: Array<Span> = []
  let start = 0
  for (const separator of text.matchAll(/\n\s*\n|\n(?=[#*-] )/g)) {
    spans.push({ start, end: separator.index })
    start = separator.index + separator[0].length
  }
  spans.push({ start, end: text.length })
  return spans
}

/** Where the last `boundary` in `window` ends, or -1. */
const lastEnd = (window: string, boundary: RegExp) => {
  let at = -1
  for (const match of window.matchAll(boundary)) at = match.index + match[0].length
  return at
}

/**
 * A paragraph in contiguous pieces of at most PIECE characters, each cut after its last line break, else its
 * last sentence end, else its last space (any of them past half a piece), else hard at PIECE.
 */
const pieces = (text: string, { start, end }: Span) => {
  const out: Array<Span> = []
  let from = start
  while (end - from > PIECE) {
    const window = text.slice(from, from + PIECE)
    const cut = [/\n/g, /[.!?]["')\]]*\s/g, /\s/g].map((boundary) => lastEnd(window, boundary)).find((at) => at > PIECE / 2) ?? PIECE
    out.push({ start: from, end: from + cut })
    from += cut
  }
  out.push({ start: from, end })
  return out
}

/**
 * A page as the model sees it: the start, or with `find` the paragraphs (oversized ones in pieces) that hold
 * the most of its terms. Picked pieces next to each other join back into the page's own text, so a quote
 * across a cut still matches; anything else is joined by `...`, which the quote check reads as a gap.
 */
const passages = (text: string, find: string | undefined) => {
  if (text.length <= SHOWN) return { text }
  const matchers = terms(find ?? "")
  if (matchers.length === 0) return { text: text.slice(0, SHOWN), note: `first ${SHOWN} of ${text.length} characters; pass find to get the passages about something` }
  const scored = paragraphs(text).flatMap((paragraph) => pieces(text, paragraph)).map((span, index) => {
    const body = text.slice(span.start, span.end)
    const lower = body.toLowerCase()
    return { ...span, index, size: body.trim().length, score: matchers.reduce((sum, matches) => sum + (matches(lower) ? 1 : 0), 0) }
  }).filter((piece) => piece.score > 0 && piece.size > 0)
  const picked: Array<typeof scored[number]> = []
  let size = 0
  for (const piece of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (size + piece.size > SHOWN) continue
    picked.push(piece)
    size += piece.size
  }
  if (picked.length === 0) return { text: text.slice(0, SHOWN), note: `nothing matched find; first ${SHOWN} of ${text.length} characters` }
  const joined: Array<Span> = []
  for (const piece of picked.sort((a, b) => a.index - b.index)) {
    const last = joined.at(-1)
    if (last !== undefined && last.end === piece.start) joined[joined.length - 1] = { start: last.start, end: piece.end }
    else joined.push(piece)
  }
  return { text: joined.map((span) => text.slice(span.start, span.end).trim()).join("\n...\n"), note: `passages matching find, from ${text.length} characters` }
}

/** A page as the caller gets it: the model its passages; a script (code mode) the whole text, plus the passages when it passed find. */
const pageFor = (url: string, text: string, find: string | undefined, caller: Caller) =>
  caller === "model" ? { url, ...passages(text, find) } : { url, text, ...(find === undefined ? {} : { passages: passages(text, find).text }) }
const PAGE = Schema.Struct({ url: Schema.String, text: Schema.String, passages: Schema.optionalKey(Schema.String) })

const refused = (message: string) => Effect.fail(new ResearchError({ message }))

const ReadArgs = Schema.Struct({ url: Schema.String.check(Schema.isPattern(/^https?:\/\//)), find: Schema.optionalKey(Schema.String) })

const Citation = Schema.Struct({ url: Schema.String, quote: Schema.String })
const Answer = Schema.Struct({ answer: Schema.String, citations: Schema.Array(Citation) })
const decodeAnswer = Schema.decodeUnknownEffect(Answer)

interface Checked {
  readonly url: string
  readonly quote: string
  readonly verified: boolean
  /**
   * What the quote was checked against: the page, only search excerpts of it (the page would not open), only
   * what Muse said about the link (a secondary account: the page would not open or did not hold it), or nothing.
   */
  readonly checked: "page" | "excerpt" | "muse" | "none"
  /** The adapter that first showed the URL, or `unseen` (no tool showed it). */
  readonly via: string
  readonly problem?: string
}

/** The platforms in the request that only Muse sees into. */
const musePlatforms = (fields: Readonly<Record<string, unknown>>) =>
  Array.isArray(fields["platforms"]) ? MUSE_PLATFORMS.filter((platform) => (fields["platforms"] as ReadonlyArray<unknown>).includes(platform)) : []

/** Characters of Muse's answer the model sees (its links come as a list besides). */
const MUSE_SHOWN = 3000

/** The research adapters over `web` (primary), `reach` (agent-reach) and `muse` (Muse's desktop app) services, or test fakes. */
export const researchPack = (
  web: Layer.Layer<Web, ToolsError, BunServices> = Web.layer,
  reach: Layer.Layer<Reach, ToolsError, BunServices> = Reach.layer,
  muse: Layer.Layer<Muse, ToolsError, BunServices> = Muse.layer
) =>
  pack<Web | Reach | Muse>({
    name: "research",
    layer: Layer.mergeAll(web, reach, muse),
    schemas,
    tools: [
      toolAdapter({
        name: "web.search",
        description:
          "PRIMARY web search, always your first search. objective: what you need found, in a sentence; queries: 1 to 3 short keyword queries (3 to 6 words; site:domain allowed). Answers results with url, title, date and an excerpt.",
        args: Schema.Struct({ objective: Schema.NonEmptyString, queries: Schema.Array(Schema.NonEmptyString) }),
        example: `{"objective": "<what you need found>", "queries": ["<3-6 words>", "<another phrasing>"]}`,
        returns: HITS,
        run: ({ objective, queries }, fields, caller) =>
          Effect.gen(function*() {
            const ledger = ledgerOf(fields)
            counted(ledger, "web.search")
            ledger.primarySearches++
            const hits = yield* (yield* Web).search(objective, queries.slice(0, 3)).pipe(
              Effect.tapError(() => Effect.sync(() => (ledger.primaryThin = true)))
            )
            if (hits.length < THIN || ledger.primarySearches >= SEARCHES_BEFORE_FALLBACK) ledger.primaryThin = true
            return {
              results: shown(ledger, "web.search", hits, caller),
              ...(ledger.primaryThin ? { note: "fallback_search (agent-reach) is now open if these do not settle it" } : {})
            }
          }).pipe(Effect.mapError((error) => ({ message: `${error.message}; fallback_search (agent-reach) is now open` })))
      }),
      toolAdapter({
        name: "web.read",
        description:
          "PRIMARY page reader for any http(s) URL: articles, docs, PDFs, GitHub repos and issues, Hacker News threads, YouTube transcripts. find: words to pull the matching passages from a long page.",
        args: ReadArgs,
        example: `{"url": "<url>", "find": "<words the passage you need contains>"}`,
        returns: PAGE,
        run: ({ url, find }, fields, caller) =>
          Effect.gen(function*() {
            const ledger = ledgerOf(fields)
            counted(ledger, "web.read")
            const page = yield* (yield* Web).read(url).pipe(
              Effect.tapError(() => Effect.sync(() => ledger.unreadable.add(urlKey(url))))
            )
            remember(ledger, "web.read", url, page.text, undefined)
            return pageFor(url, page.text, find, caller)
          }).pipe(Effect.mapError((error) => ({ message: `${error.message}; fallback_read (agent-reach) is now open for this url` })))
      }),
      toolAdapter({
        name: "web.screenshot",
        description:
          "PRIMARY page screenshot, only at depth deep and only for a question about how a page looks (layout, a chart, a logo, a design). The image is attached to your next turn: look at it and say what you see; it is not a quotable source, so cite a read page for the claims. Read it first when the facts are in its text.",
        args: Schema.Struct({ url: Schema.String.check(Schema.isPattern(/^https?:\/\//)) }),
        example: `{"url": "<url>"}`,
        returns: Schema.Struct({ url: Schema.String, image: Schema.String }),
        run: ({ url }, fields, caller) =>
          Effect.gen(function*() {
            if (fields["depth"] !== "deep") return yield* refused("closed: screenshots open only at depth deep")
            if (caller !== "model") return yield* refused("closed: a screenshot reaches only the model's own turns, not a script; call screenshot as a tool")
            counted(ledgerOf(fields), "web.screenshot")
            return { url, image: yield* (yield* Web).screenshot(url) }
          })
      }),
      toolAdapter({
        name: "reach.fallback_search",
        description:
          "agent-reach FALLBACK web search (Exa). Opens only after search failed, returned fewer than 3 results, or ran twice. query: a description of the ideal page.",
        args: Schema.Struct({ query: Schema.NonEmptyString }),
        example: `{"query": "<the ideal page, described>"}`,
        returns: HITS,
        run: ({ query }, fields, caller) =>
          Effect.gen(function*() {
            const ledger = ledgerOf(fields)
            const unasked = musePlatforms(fields).filter((platform) => !ledger.muse.has(platform))
            if (unasked.length > 0) return yield* refused(`closed: the request names ${unasked.join(", ")}; ask social_search (Muse) first, agent-reach opens after it`)
            if (!ledger.primaryThin) return yield* refused("closed: fallback_search opens only after search fails, returns fewer than 3 results or has run twice; call search first")
            counted(ledger, "reach.fallback_search")
            return { results: shown(ledger, "reach.fallback_search", yield* (yield* Reach).search(query, query), caller) }
          })
      }),
      toolAdapter({
        name: "reach.fallback_read",
        description: "agent-reach FALLBACK page reader (Jina, then Exa). Opens only for a URL read could not read. find: as for read.",
        args: ReadArgs,
        example: `{"url": "<a url read failed on>", "find": "<words>"}`,
        returns: PAGE,
        run: ({ url, find }, fields, caller) =>
          Effect.gen(function*() {
            const ledger = ledgerOf(fields)
            if (!ledger.unreadable.has(urlKey(url))) return yield* refused("closed: fallback_read opens only for a url read failed on; call read first")
            counted(ledger, "reach.fallback_read")
            const page = yield* (yield* Reach).read(url)
            remember(ledger, "reach.fallback_read", url, page.text, undefined)
            return pageFor(url, page.text, find, caller)
          })
      }),
      toolAdapter({
        name: "reach.platform_search",
        description:
          "agent-reach PLATFORM search, only for a platform the request names: github (gh search; kind repos, issues or code, default repos), youtube, reddit, x, xiaohongshu, and instagram, facebook or marketplace once social_search (Muse) failed or found nothing for it (results from that platform's own pages). Read a result's url with read.",
        args: Schema.Struct({ platform: Schema.Literals(PLATFORMS), query: Schema.NonEmptyString, kind: Schema.optionalKey(Schema.Literals(["repos", "issues", "code"])) }),
        example: `{"platform": "github", "query": "<keywords>", "kind": "repos"}`,
        returns: HITS,
        run: ({ platform, query, kind }, fields, caller) =>
          Effect.gen(function*() {
            const named = Array.isArray(fields["platforms"]) ? (fields["platforms"] as ReadonlyArray<unknown>).filter((entry) => typeof entry === "string") : []
            if (!named.includes(platform)) return yield* refused(`closed: the request names ${named.length === 0 ? "no platforms" : named.join(", ")}; platform_search only searches those`)
            const ledger = ledgerOf(fields)
            if ((MUSE_PLATFORMS as ReadonlyArray<string>).includes(platform)) {
              const muse = ledger.muse.get(platform as MusePlatform)
              if (muse === undefined) return yield* refused(`closed: ask social_search (Muse) about ${platform} first; platform_search opens for it if Muse fails or finds nothing`)
              if (muse === "answered") return yield* refused(`closed: Muse answered for ${platform} with links; read those links instead`)
            }
            counted(ledger, "reach.platform_search")
            const hits = yield* (yield* Reach).platform(platform as Platform, query, (kind ?? "repos") as GithubKind)
            return hits.length === 0 ? { results: [], note: `nothing from ${platform}; try search with site:` } : { results: shown(ledger, "reach.platform_search", hits, caller) }
          })
      }),
      toolAdapter({
        name: "muse.social_search",
        description:
          "Muse (Meta AI, signed in as Isaac) searches Instagram, Facebook (groups, pages) or Facebook Marketplace, which plain search cannot see into, and answers with links to the posts, reels or listings. Only for a platform the request names; one question per platform, slow (about a minute). Muse is a SECONDARY source: read its links to confirm, and cite a link with a quote from that page; when the page will not open, a quote from what Muse said about that link counts, marked as Muse's. question: the full question, with place and time if they matter.",
        args: Schema.Struct({ platform: Schema.Literals(MUSE_PLATFORMS), question: Schema.NonEmptyString }),
        example: `{"platform": "instagram", "question": "<the full question>"}`,
        returns: Schema.Struct({ answer: Schema.String, links: Schema.Array(Schema.Struct({ url: Schema.String, context: Schema.String })), note: Schema.String }),
        run: ({ platform, question }, fields) =>
          Effect.gen(function*() {
            const named = musePlatforms(fields)
            if (!named.includes(platform)) return yield* refused(`closed: the request names ${named.length === 0 ? "none of instagram, facebook, marketplace" : named.join(", ")}; social_search only searches those`)
            const ledger = ledgerOf(fields)
            if (ledger.muse.has(platform)) return yield* refused(`closed: Muse was already asked about ${platform} for this request; work from its answer`)
            counted(ledger, "muse.social_search")
            const answer = yield* (yield* Muse).ask(question, platform).pipe(
              Effect.tapError(() => Effect.sync(() => ledger.muse.set(platform, "failed")))
            )
            ledger.muse.set(platform, answer.links.length > 0 ? "answered" : "empty")
            for (const link of answer.links) {
              remember(ledger, "muse.social_search", link.url, undefined, undefined)
              ledger.sources.get(urlKey(link.url))?.muse.push(normalize(link.context))
            }
            return {
              answer: answer.text.length > MUSE_SHOWN ? `${answer.text.slice(0, MUSE_SHOWN)} ...` : answer.text,
              links: answer.links,
              note: [
                "Muse is a secondary source: read each link you rely on and quote the page; if it will not open, quote what Muse said about that link.",
                ...(answer.cards > 0 ? [`${answer.cards} preview card(s) in Muse's answer had no readable URL and are left out.`] : []),
                ...(answer.listings.length > 0 ? [`Muse showed ${answer.listings.length} listing card(s) without URL or price (titles in the answer as "Listing: ..."); they cannot be cited.`] : []),
                ...(answer.links.length === 0 ? [`no links from Muse: platform_search (agent-reach) is now open for ${platform}`] : [])
              ].join(" ")
            }
          }).pipe(Effect.mapError((error) => ({ message: `${error.message}; platform_search (agent-reach) is now open for ${platform}` })))
      })
    ],
    checks: [{
      name: "research.citations",
      description:
        "For an answer {answer, citations[{url, quote}]}: every quote must appear on its page (markdown, quotes, dashes, case and spacing folded; ... joins two spans of one page). The page is the text a reader returned in this item, else it is read now (primary reader, then agent-reach's), else the search excerpts of it count. A link Muse gave is checked on its page first; only when the page will not open or does not hold the quote do Muse's own words about it count (checked muse, a secondary source). No citation, or any quote not found, gets one repair turn; still failing, the answer goes out with each citation's verified false. Provides answer, citations[{url, quote, verified, checked page|excerpt|muse|none, via}], route (primary, muse, platform and fallback, those used, joined by +, or none) and toolCalls.",
      provides: ["answer", "citations", "route", "toolCalls"],
      check: (reply, context) =>
        Effect.gen(function*() {
          const answer = yield* decodeAnswer(reply.answer).pipe(
            Effect.mapError((error) => new ResearchError({ message: `research.citations needs {answer, citations}: ${error.message}` }))
          )
          const ledger = ledgerOf(context.fields)
          const web = yield* Web
          const reach = yield* Reach
          const verify = (citation: typeof Citation.Type) =>
            Effect.gen(function*() {
              const base = { url: citation.url, quote: citation.quote, via: ledger.sources.get(urlKey(citation.url))?.via ?? "unseen" }
              if (normalize(citation.quote).length < MIN_QUOTE) return { ...base, verified: false, checked: "none", problem: `quote shorter than ${MIN_QUOTE} characters` } satisfies Checked
              let source = ledger.sources.get(urlKey(citation.url))
              if (source?.page === undefined) {
                const page = yield* web.read(citation.url).pipe(Effect.catch(() => reach.read(citation.url)), Effect.option)
                if (Option.isSome(page)) {
                  remember(ledger, source?.via ?? "unseen", citation.url, page.value.text, undefined)
                  source = ledger.sources.get(urlKey(citation.url))
                }
              }
              if (source?.page !== undefined && quoteIn(citation.quote, source.page)) return { ...base, verified: true, checked: "page" } satisfies Checked
              const excerpted = source?.page === undefined && source !== undefined && source.excerpts.some((excerpt) => quoteIn(citation.quote, excerpt))
              if (excerpted) return { ...base, verified: true, checked: "excerpt" } satisfies Checked
              if (source !== undefined && source.muse.some((said) => quoteIn(citation.quote, said))) return { ...base, verified: true, checked: "muse" } satisfies Checked
              if (source?.page !== undefined) return { ...base, verified: false, checked: "page", problem: "quote not found on the page" } satisfies Checked
              if (source !== undefined && source.excerpts.length > 0) {
                return { ...base, verified: false, checked: "excerpt", problem: "the page would not open and no search excerpt of it holds the quote" } satisfies Checked
              }
              return { ...base, verified: false, checked: "none", problem: "the page would not open and no tool showed it" } satisfies Checked
            })
          const checked: ReadonlyArray<Checked> = yield* Effect.forEach(answer.citations, verify, { concurrency: 4 })
          const routes = new Set([...ledger.calls.keys()].flatMap((name) => ROUTE[name] ?? []))
          const fields = {
            answer: answer.answer,
            citations: checked.map(({ problem: _, ...citation }) => citation),
            route: (["primary", "muse", "platform", "fallback"] as const).filter((route) => routes.has(route)).join("+") || "none",
            toolCalls: Object.fromEntries(ledger.calls)
          }
          const problems = [
            ...(checked.length === 0 ? ["no citations: cite at least one source with a verbatim quote"] : []),
            ...checked.flatMap((citation) => citation.problem === undefined ? [] : [`${citation.url}: ${citation.problem}. Quote: "${citation.quote}"`])
          ]
          if (problems.length === 0) return { pass: true as const, fields }
          return {
            pass: false as const,
            repair: [
              context.prompt,
              "## Your last answer",
              reply.text,
              "## Citations that failed the check",
              ...problems.map((problem) => `- ${problem}`),
              "Fix them: copy each quote character for character from a page or search result a tool showed you (read the page again if you need to), or drop the citation. Keep at least one citation. Then answer again."
            ].join("\n\n"),
            giveUp: Effect.succeed(fields)
          }
        })
    }]
  })
