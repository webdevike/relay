import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { flaggedItems, Flags, Item, Slack } from "./adapters/slack.ts"
import { type Component, define, job, Trigger } from "../../src/core/Component.ts"

/**
 * `kind: "code"` agent (`ecard-slack-fetch.json`, next to this file): the fetch in front of ecard-slack-triage. No model and no
 * per-item turn, so the agent spec does not fit: one proxy call reads every new flag's thread, then one event per item.
 */

const events = {
  /** One per new item Elysia flagged under Needs your attention, with its Slack text: ecard-slack-triage's input. */
  "item.fetched": Item,
  "fetch.completed": Schema.Struct({ flagged: Schema.Int, fresh: Schema.Int, fetched: Schema.Int })
}

export class SeenError extends Schema.TaggedError<SeenError>()("SeenError", { message: Schema.String }) {}

/** Items per run; the rest wait for the next run. One proxy call covers them all. */
export const MAX_PER_RUN = 12
const decodeSeen = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))

const fetch = job(events, {
  id: "fetch",
  description: "Fetch the thread text of new Slack items Elysia flagged (read-only, claude proxy) and hand each to ecard-slack-triage.",
  input: Schema.Struct({}),
  triggers: [Trigger.Manual(), Trigger.Cron({ cron: "20 * * * *", input: Effect.succeed({}) })],
  run: Effect.fnUntraced(function*(_, ctx) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(ctx.stateDir, "seen.json")
    const seenError = (error: { readonly message: string }) => new SeenError({ message: `${file}: ${error.message}` })
    const seen = (yield* fs.exists(file).pipe(Effect.mapError(seenError)))
      ? yield* fs.readFileString(file).pipe(Effect.flatMap(decodeSeen), Effect.mapError(seenError))
      : []
    const flagged = flaggedItems(yield* (yield* Flags).read)
    const known = new Set(seen)
    const fresh = flagged.filter((item) => !known.has(item.url.split("?")[0]!))
    const batch = fresh.slice(0, MAX_PER_RUN)
    const threads = batch.length === 0 ? [] : yield* (yield* Slack).threads(batch.map((item) => item.url))
    for (const item of batch) {
      const thread = threads.find((candidate) => candidate.url.split("?")[0] === item.url.split("?")[0])
      if (thread !== undefined && thread.messages.length > 0) yield* ctx.emit("item.fetched", { ...thread, url: item.url, summary: item.summary })
    }
    // Seen once tried: an item the proxy could not read is not retried every hour.
    const next = [...seen, ...batch.map((item) => item.url.split("?")[0]!)].slice(-500)
    yield* fs.writeFileString(`${file}.tmp`, `${JSON.stringify(next)}\n`).pipe(Effect.andThen(fs.rename(`${file}.tmp`, file)), Effect.mapError(seenError))
    yield* ctx.emit("fetch.completed", { flagged: flagged.length, fresh: fresh.length, fetched: threads.length })
  })
})

export const spec = {
  id: "ecard-slack-fetch",
  events,
  purpose: "Fetch the Slack text of each new item Elysia flagged, read-only, for ecard-slack-triage.",
  agent: {
    // No model calls: the fetch is a fixed read. Kept for the Component shape.
    model: "anthropic/claude-haiku-5-5",
    candidates: ["anthropic/claude-haiku-5-5"],
    system: ""
  },
  jobs: [fetch],
  tools: Layer.mergeAll(Slack.layer, Flags.layer)
} satisfies Component<Slack | Flags>

export default define(spec)
