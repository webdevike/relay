import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import type { Pack } from "../src/Adapter.ts"
import { packs as defaultPacks } from "../src/adapters/index.ts"
import { type Hit, ResearchError } from "../src/adapters/research/http.ts"
import { Muse, type MuseAnswer } from "../src/adapters/research/muse.ts"
import { researchPack } from "../src/adapters/research/pack.ts"
import { Reach } from "../src/adapters/research/reach.ts"
import { navOnly, Web } from "../src/adapters/research/web.ts"
import { EventBus } from "../src/Event.ts"
import { type GenerateRequest, ModelRunner } from "../src/Model.ts"
import { Runner } from "../src/Runtime.ts"
import { builtinChefs, runtime, tempHome } from "./harness.ts"

/** Answers each call with the next scripted reply (one JSON object, as the tool loop wants); records every request. */
const scripted = (replies: ReadonlyArray<unknown>) =>
  Effect.gen(function*() {
    const seen = yield* Ref.make<ReadonlyArray<GenerateRequest>>([])
    const models = ModelRunner.of({
      generate: (request) =>
        Ref.modify(seen, (all) => [all.length, [...all, request]]).pipe(
          Effect.map((index) => ({ text: JSON.stringify(replies[Math.min(index, replies.length - 1)]), model: request.model, provider: "test", seconds: 0, cost: 0.01 }))
        )
    })
    return { models, seen }
  })

interface FakeWeb {
  readonly hits?: ReadonlyArray<Hit>
  /** url → page text; any other url fails to read. */
  readonly pages?: Readonly<Record<string, string>>
}

const read = (pages: Readonly<Record<string, string>> | undefined) => (url: string) =>
  pages?.[url] === undefined ? Effect.fail(new ResearchError({ message: `read ${url}: certificate error` })) : Effect.succeed({ url, text: pages[url] })

/** Muse answers with `answer`, or fails with `failure`; by default it is out of reach (no test drives the real app). */
interface FakeMuse {
  readonly answer?: MuseAnswer
  readonly failure?: string
}

const fakes = (web: FakeWeb, reach: FakeWeb & { readonly platform?: ReadonlyArray<Hit> }, muse: FakeMuse = {}): ReadonlyArray<Pack> => [
  ...defaultPacks.filter((candidate) => candidate.name !== "research"),
  researchPack(
    Layer.succeed(Web, Web.of({ search: () => Effect.succeed(web.hits ?? []), read: read(web.pages) })),
    Layer.succeed(Reach, Reach.of({ search: () => Effect.succeed(reach.hits ?? []), read: read(reach.pages), platform: () => Effect.succeed(reach.platform ?? []) })),
    Layer.succeed(Muse, Muse.of({
      ask: () => muse.answer !== undefined ? Effect.succeed(muse.answer) : Effect.fail(new ResearchError({ message: muse.failure ?? "muse unavailable: not in tests" }))
    }))
  )
]

/** Run the shipped web-researcher chef (in `toolMode`, default as shipped) once over a temp home; answer its research.answered data and the model requests. */
const research = (input: Readonly<Record<string, unknown>>, replies: ReadonlyArray<unknown>, packs: ReadonlyArray<Pack>, toolMode?: "code") =>
  Effect.gen(function*() {
    const root = yield* tempHome
    const dir = yield* builtinChefs(root, ["web-researcher"])
    const { models, seen } = yield* scripted(replies)
    return yield* Effect.gen(function*() {
      const result = yield* (yield* Runner).run("web-researcher", "answer", input, { model: "test/model", ...(toolMode === undefined ? {} : { toolMode }) })
      const events = yield* (yield* EventBus).history
      const output = events.find((event) => event.type === "web-researcher/research.answered" && event.run === result.run)
      return { ok: result.ok, data: output?.data as Record<string, any> | undefined, requests: yield* Ref.get(seen) }
    }).pipe(Effect.provide(runtime(root, { dirs: [dir], packs }, models)))
  }).pipe(Effect.scoped)

const PAGE = "# Release notes\n\nThe **1.4** release shipped on “October 22, 2026” with bun fmt.\n\nUnrelated paragraph."

/** Pages as `omp read` (or `.jina.md`: agent-reach's Jina reader) returned them on 2026-11-15, when the web-researcher needle test caught each bug. */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/research/${name}`, import.meta.url), "utf8")

describe("web-researcher", () => {
  test("agent-reach opens only after the primary source comes up thin or fails; quotes are checked on the page or the excerpt; route says which source answered", () =>
    Effect.gen(function*() {
      const { ok, data, requests } = yield* research(
        { question: "When did 1.4 ship?", depth: "quick" },
        [
          { tool: "fallback_search", args: { query: "1.4 release" } },
          { tool: "search", args: { objective: "1.4 release date", queries: ["1.4 release date"] } },
          { tool: "fallback_search", args: { query: "1.4 release notes" } },
          { tool: "read", args: { url: "https://b.test/notes" } },
          { tool: "fallback_read", args: { url: "https://b.test/notes", find: "release" } },
          {
            answer: {
              answer: "October 22, 2026.",
              citations: [
                // Markdown, smart quotes and a ... between two spans still match the page.
                { url: "https://b.test/notes/", quote: "The 1.4 release shipped on \"October 22, 2026\"...bun fmt" },
                { url: "https://a.test", quote: "1.4 is planned for late October" }
              ]
            }
          }
        ],
        fakes(
          { hits: [{ url: "https://a.test", title: "A", text: "Roadmap: 1.4 is planned for late October." }] },
          { hits: [{ url: "https://b.test/notes", title: "B", text: "notes" }], pages: { "https://b.test/notes": PAGE } }
        )
      )
      expect(ok).toBe(true)
      expect(requests[1]!.prompt).toContain("closed: fallback_search opens only after search fails")
      // One result is thin: the fallback is open on the next call, and fallback_read for the url read failed on.
      expect(requests[3]!.prompt).toContain("fallback_search (agent-reach) is now open")
      expect(requests[5]!.prompt).toContain("fallback_read (agent-reach) is now open for this url")
      expect(data!["citations"]).toEqual([
        { url: "https://b.test/notes/", quote: "The 1.4 release shipped on \"October 22, 2026\"...bun fmt", verified: true, checked: "page", via: "reach.fallback_search" },
        // a.test never opens (neither reader has it): its search excerpt holds the quote.
        { url: "https://a.test", quote: "1.4 is planned for late October", verified: true, checked: "excerpt", via: "web.search" }
      ])
      expect(data!["route"]).toBe("primary+fallback")
      expect(data!["toolCalls"]).toEqual({ "web.search": 1, "reach.fallback_search": 1, "web.read": 1, "reach.fallback_read": 1 })
      expect(data!["attempts"]).toBe(6)
    }).pipe(Effect.runPromise), 20_000)

  test("platform_search searches only the platforms named; a quote not on its page gets one repair, then goes out marked unverified", () =>
    Effect.gen(function*() {
      const bad = { answer: { answer: "It is MIT licensed.", citations: [{ url: "https://github.com/o/r", quote: "licensed under the MIT license" }] } }
      const { ok, data, requests } = yield* research(
        { question: "What license is o/r under?", platforms: ["github"] },
        [
          { tool: "platform_search", args: { platform: "reddit", query: "o/r license" } },
          { tool: "platform_search", args: { platform: "github", query: "o/r" } },
          bad,
          bad
        ],
        fakes(
          { pages: { "https://github.com/o/r": "# r\n\nApache-2.0 license" } },
          { platform: [{ url: "https://github.com/o/r", title: "o/r", text: "A tool (10 stars)" }] }
        )
      )
      expect(ok).toBe(true)
      expect(requests[1]!.prompt).toContain("closed: the request names github; platform_search only searches those")
      expect(requests.length).toBe(4)
      expect(requests[3]!.prompt).toContain("https://github.com/o/r: quote not found on the page")
      expect(data!["answer"]).toBe("It is MIT licensed.")
      expect(data!["citations"]).toEqual([{ url: "https://github.com/o/r", quote: "licensed under the MIT license", verified: false, checked: "page", via: "reach.platform_search" }])
      expect(data!["route"]).toBe("platform")
    }).pipe(Effect.runPromise), 20_000)

  test("a quote is checked on the page as read: `1<<24` in a code sample is code, not an HTML tag that swallows the page up to the next >", () =>
    Effect.gen(function*() {
      const url = "https://go.dev/doc/go1.2"
      const quote = "In Go 1.2, the minimum size of the stack when a goroutine is created has been lifted from 4KB to 8KB."
      const { data } = yield* research(
        { question: "Which Go release raised the minimum goroutine stack size from 4KB?" },
        [
          { tool: "read", args: { url, find: "goroutine stack size" } },
          { answer: { answer: "Go 1.2 raised it from 4KB to 8KB.", citations: [{ url, quote }] } }
        ],
        fakes({ pages: { [url]: fixture("go1.2.md") } }, {})
      )
      expect(data!["citations"]).toEqual([{ url, quote, verified: true, checked: "page", via: "web.read" }])
      expect(data!["attempts"]).toBe(2)
    }).pipe(Effect.runPromise), 20_000)

  test("read's find matches short and symbol-bearing tokens whole: q=0.30 z=24 pulls the whitepaper's table row", () =>
    Effect.gen(function*() {
      const url = "https://bitcoin.org/bitcoin.pdf"
      const { requests } = yield* research(
        { question: "In the Bitcoin whitepaper, what z keeps an attacker with q=0.30 under 0.1%?" },
        [
          { tool: "read", args: { url, find: "q=0.30 z=24" } },
          { answer: { answer: "z=24.", citations: [{ url, quote: "q=0.25 z=15 q=0.30 z=24" }] } }
        ],
        fakes({ pages: { [url]: fixture("bitcoin.pdf.md") } }, {})
      )
      expect(requests[1]!.prompt).toContain("passages matching find")
      expect(requests[1]!.prompt).toContain("q=0.30 z=24")
    }).pipe(Effect.runPromise), 20_000)

  test("find reaches deep into an oversized paragraph: Jina's bitcointalk thread is one 30k-character paragraph, and its posts are the passages shown and quoted", () =>
    Effect.gen(function*() {
      const url = "https://bitcointalk.org/index.php?topic=137.0"
      const quote = "just standard stuff no weird fish topping or anything like that. ... I just want to report that I successfully traded 10,000 bitcoins for pizza."
      const { data, requests } = yield* research(
        { question: "In the 2010 bitcointalk pizza thread, what topping did he not want, and whom did he thank?" },
        [
          { tool: "read", args: { url } },
          { tool: "fallback_read", args: { url, find: "weird fish topping thanks jercos" } },
          { answer: { answer: "No weird fish topping; he thanked jercos.", citations: [{ url, quote }, { url, quote: "Pictures: http://heliacal.net/~solar/bitcoin/pizza/ Thanks jercos!" }] } }
        ],
        fakes({}, { pages: { [url]: fixture("bitcointalk-137.jina.md") } })
      )
      // Before, the window only took whole paragraphs, so find fell back to the first 4,500 characters: the avatar header.
      expect(requests[2]!.prompt).toContain("passages matching find")
      expect(requests[2]!.prompt).toContain("no weird fish topping or anything like that")
      expect(requests[2]!.prompt).toContain("Thanks jercos!")
      expect(data!["citations"]).toEqual([
        { url, quote, verified: true, checked: "page", via: "reach.fallback_read" },
        { url, quote: "Pictures: http://heliacal.net/~solar/bitcoin/pizza/ Thanks jercos!", verified: true, checked: "page", via: "reach.fallback_read" }
      ])
      expect(data!["attempts"]).toBe(3)
    }).pipe(Effect.runPromise), 20_000)

  test("code mode: one script runs the tools side by side and filters a whole page in the sandbox; gates, ledger and quote check hold as in tool mode", () =>
    Effect.gen(function*() {
      const url = "https://go.dev/doc/go1.2"
      const quote = "In Go 1.2, the minimum size of the stack when a goroutine is created has been lifted from 4KB to 8KB."
      const code = [
        `const [found, page] = await Promise.all([search({ objective: "go 1.2 stack", queries: ["go 1.2 stack size"] }), read({ url: "${url}" })])`,
        `let gate = ""`,
        `try { await fallback_read({ url: "${url}" }) } catch (error) { gate = error.message }`,
        `return { hits: found.results.length, gate, lines: page.text.split("\\n").filter((line) => /minimum size of the stack/.test(line)) }`
      ].join("\n")
      const { data, requests } = yield* research(
        { question: "Which Go release raised the minimum goroutine stack size from 4KB?" },
        [{ tool: "run_code", args: { code } }, { answer: { answer: "Go 1.2, from 4KB to 8KB.", citations: [{ url, quote }] } }],
        fakes({ hits: [{ url, title: "Go 1.2 Release Notes", text: "Go 1.2 release notes" }], pages: { [url]: fixture("go1.2.md") } }, {}),
        "code"
      )
      expect(requests[0]!.system).toContain("declare function read(args: { url: string; find?: string }): Promise<{ url: string; text: string; passages?: string }>")
      // The script got the whole 29k-character page (the model's window is the first 4,500 without find) and returned one line of it.
      expect(requests[1]!.prompt).toContain(quote)
      expect(requests[1]!.prompt).toContain("closed: fallback_read opens only for a url read failed on")
      expect(data!["citations"]).toEqual([{ url, quote, verified: true, checked: "page", via: "web.search" }])
      expect(data!["toolCalls"]).toEqual({ "web.search": 1, "web.read": 1 })
      expect(data!["attempts"]).toBe(2)
    }).pipe(Effect.runPromise), 20_000)

  test("a read that returns only the site's navigation counts as failed (so fallback_read opens); a short page of real text still reads", () => {
    expect(navOnly(fixture("bitcointalk-137.md"))).toBe(true)
    expect(navOnly(fixture("go1.2.md"))).toBe(false)
    expect(navOnly(fixture("bitcoin.pdf.md"))).toBe(false)
    expect(navOnly("---\ntitle: Example Domain\n---\n\nThis domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.")).toBe(false)
  })

  test("Instagram goes to Muse before agent-reach; a Muse link is checked on its page when it opens, on Muse's own words about it when it will not", () =>
    Effect.gen(function*() {
      const reel = "https://www.instagram.com/reel/DfOBe5SSVij/"
      const post = "https://www.instagram.com/p/DfAd_YujpDx/"
      const { ok, data, requests } = yield* research(
        { question: "Which Melbourne specialty coffee reels are trending?", platforms: ["instagram"] },
        [
          { tool: "platform_search", args: { platform: "instagram", query: "melbourne specialty coffee reels" } },
          { tool: "fallback_search", args: { query: "melbourne specialty coffee reels" } },
          { tool: "social_search", args: { platform: "instagram", question: "Which Melbourne specialty coffee reels are trending?" } },
          { tool: "read", args: { url: reel } },
          {
            answer: {
              answer: "Homebody Union in Fitzroy, the World Barista Champion's cafe, is the most-shared new spot.",
              citations: [
                { url: reel, quote: "Melbourne's newest coffee spot by a World Barista Champion" },
                { url: post, quote: "A carousel / video listicle covering Disciple, Path" }
              ]
            }
          }
        ],
        fakes(
          { pages: { [reel]: "kimmyyliew on Instagram: Melbourne’s newest coffee spot by a World Barista Champion. Champion’s Signature Coffee Set." } },
          {},
          {
            answer: {
              text: "1. Homebody Union, Fitzroy\nhttps://www.instagram.com/reel/DfOBe5SSVij/\n2. Best specialty coffee shops in Melbourne — @fltr_magazine\nhttps://www.instagram.com/p/DfAd_YujpDx/",
              links: [
                { url: reel, context: "8. Homebody Union, Fitzroy — @kimmyyliew\nWaiting an hour at the World Barista Champion Anthony Douglas cafe." },
                { url: post, context: "2. Best specialty coffee shops in Melbourne — @fltr_magazine\n3.4K likes. A carousel / video listicle covering Disciple, Path, Calēre." }
              ],
              cards: 2,
              listings: [],
              seconds: 40
            }
          }
        )
      )
      expect(ok).toBe(true)
      expect(requests[1]!.prompt).toContain("closed: ask social_search (Muse) about instagram first")
      expect(requests[2]!.prompt).toContain("closed: the request names instagram; ask social_search (Muse) first")
      expect(requests[3]!.prompt).toContain("Muse is a secondary source")
      expect(requests[3]!.prompt).toContain("2 preview card(s)")
      expect(data!["citations"]).toEqual([
        { url: reel, quote: "Melbourne's newest coffee spot by a World Barista Champion", verified: true, checked: "page", via: "muse.social_search" },
        // The post will not open (Instagram's login wall): Muse's words about it are all there is, marked as Muse's.
        { url: post, quote: "A carousel / video listicle covering Disciple, Path", verified: true, checked: "muse", via: "muse.social_search" }
      ])
      expect(data!["route"]).toBe("primary+muse")
      expect(data!["toolCalls"]).toEqual({ "muse.social_search": 1, "web.read": 1 })
    }).pipe(Effect.runPromise), 20_000)

  test("Muse failing (signed out) says so and opens agent-reach's route for that platform; a second Muse ask is refused", () =>
    Effect.gen(function*() {
      const group = "https://www.facebook.com/groups/espresso/posts/123/"
      const { ok, data, requests } = yield* research(
        { question: "What do espresso groups say about the Lelit Bianca?", platforms: ["facebook"] },
        [
          { tool: "social_search", args: { platform: "facebook", question: "Lelit Bianca opinions in espresso groups" } },
          { tool: "social_search", args: { platform: "facebook", question: "Lelit Bianca again" } },
          { tool: "platform_search", args: { platform: "facebook", query: "Lelit Bianca espresso group" } },
          { answer: { answer: "Owners praise its flow paddle.", citations: [{ url: group, quote: "the flow paddle is the reason to buy it" }] } }
        ],
        fakes({}, { platform: [{ url: group, title: "Espresso group", text: "Honestly the flow paddle is the reason to buy it." }] }, {
          failure: "muse signed out: Muse is signed out: Isaac needs to open Muse and log in to Meta"
        })
      )
      expect(ok).toBe(true)
      expect(requests[1]!.prompt).toContain("muse signed out: Muse is signed out")
      expect(requests[1]!.prompt).toContain("platform_search (agent-reach) is now open for facebook")
      expect(requests[2]!.prompt).toContain("closed: Muse was already asked about facebook")
      expect(data!["citations"]).toEqual([{ url: group, quote: "the flow paddle is the reason to buy it", verified: true, checked: "excerpt", via: "reach.platform_search" }])
      expect(data!["route"]).toBe("muse+platform")
    }).pipe(Effect.runPromise), 20_000)
})
