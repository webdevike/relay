import { Context, Effect, Layer, Semaphore } from "effect"
import { createActor } from "xstate"
import { ResearchError } from "./http.ts"
import type { AskOutput } from "./muse/ask.machine.ts"
import { connectCua } from "./muse/cua.ts"
import { museAsk } from "./muse/driver.ts"
import type { MuseLink } from "./muse/screen.ts"

/** The platforms only Muse (Meta AI, signed in as Isaac) can see into. */
export const MUSE_PLATFORMS = ["instagram", "facebook", "marketplace"] as const
export type MusePlatform = typeof MUSE_PLATFORMS[number]

export interface MuseAnswer {
  readonly text: string
  readonly links: ReadonlyArray<MuseLink>
  /** Preview cards in the answer whose URL Muse's window does not expose. */
  readonly cards: number
  /** Titles of Marketplace listing cards Muse showed (no URL or price exposed). */
  readonly listings: ReadonlyArray<string>
  readonly seconds: number
}

/** Quiet time between two questions to Muse, so the account never looks like a script hammering it. */
const GAP_MS = 20_000

const WHERE: Readonly<Record<MusePlatform, { readonly where: string; readonly item: string; readonly facts: string }>> = {
  instagram: { where: "Instagram (posts and reels)", item: "post or reel", facts: "account, date and what it shows" },
  facebook: { where: "Facebook (groups, and public pages and posts)", item: "group post or post", facts: "group, date and what it says" },
  marketplace: { where: "Facebook Marketplace (listings near me)", item: "listing", facts: "title, price and location" }
}

/** What Muse is asked: the guard rails first, then the question, then how to give links. One line: Return sends. */
export const musePrompt = (question: string, platform: MusePlatform) =>
  [
    "Read-only research request: do not post, comment, message, react, like, follow, join, buy, bid, save or contact anyone, and do not use Messages or any connector that sends something; only look things up.",
    `Search ${WHERE[platform].where} for this: ${question.replace(/\s+/g, " ").trim()}`,
    `Answer from what you find there. For every ${WHERE[platform].item} you mention, write in plain text (not as a card) its ${WHERE[platform].facts}, then its direct link written out as the full https:// URL, not as link text.`,
    "If you cannot find any, say so."
  ].join(" ")

/** One question through Muse's desktop app, start to finish; cancelling stops the machine and the driver. */
const run = (prompt: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const cua = await connectCua()
      const actor = createActor(museAsk(cua), { input: { prompt } })
      const started = Date.now()
      try {
        const { promise, resolve, reject } = Promise.withResolvers<AskOutput>()
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        actor.subscribe((snapshot) => {
          if (snapshot.status === "done") resolve(snapshot.output)
        })
        actor.start()
        const output = await promise
        return { output, seconds: Math.round((Date.now() - started) / 1000) }
      } finally {
        actor.stop()
        cua.close()
      }
    },
    catch: (error) => new ResearchError({ message: `muse: ${error instanceof Error ? error.message : String(error)}` })
  })

/**
 * Muse as a research source: one question at a time through Muse's desktop app (`muse/driver.ts`), with
 * a quiet gap between questions. A failure (Muse signed out, busy, rate limited, its UI changed, no
 * answer in time) is a ResearchError naming what happened, so the caller can fall back.
 */
export class Muse extends Context.Service<Muse, {
  ask(question: string, platform: MusePlatform): Effect.Effect<MuseAnswer, ResearchError>
}>()("atomic-agents/research/Muse") {
  static readonly layer = Layer.effect(
    Muse,
    Effect.gen(function*() {
      const lock = yield* Semaphore.make(1)
      let lastEnd = 0
      const ask = Effect.fn("Muse.ask")(function*(question: string, platform: MusePlatform) {
        const wait = lastEnd + GAP_MS - Date.now()
        if (wait > 0) yield* Effect.sleep(wait)
        const { output, seconds } = yield* run(musePrompt(question, platform)).pipe(Effect.ensuring(Effect.sync(() => (lastEnd = Date.now()))))
        if (!output.ok) return yield* new ResearchError({ message: `muse ${output.kind.replace("_", " ")}: ${output.message}` })
        return { text: output.reply.text, links: output.reply.links, cards: output.reply.cards, listings: output.reply.listings, seconds } satisfies MuseAnswer
      })
      return Muse.of({ ask: (question, platform) => ask(question, platform).pipe(lock.withPermits(1)) })
    })
  )
}
