import { Clock, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Activity, flaggedItems, Flags, Item, Slack, Source, SourceChoice, Thread } from "./adapters/slack.ts"
import { type Component, define, job, Trigger } from "../../src/core/Component.ts"

/**
 * `kind: "code"` agent (`ecard-slack-fetch.json`, next to this file): Isaac's eCard Slack, read-only, no model.
 * - `activity` (manual, what `request` runs): what is new since a cursor plus the threads of given permalinks, one read;
 *   Eva's `jobs/ecard-slack-triage` asks it each run.
 * - `fetch` (cron): the thread text of each new item Elysia flagged, for the ecard-slack-triage agent.
 * Both read through the claude proxy and fall back to Slack desktop over CDP when the proxy fails (`adapters/slack.ts`);
 * `source` in the input (or env `ECARD_SLACK_SOURCE`) forces one.
 */

const Sourced = {
  source: Source,
  /** Why the run left the claude proxy for Slack desktop. */
  fallbackReason: Schema.optionalKey(Schema.String)
}

const events = {
  /** One `activity` read: newest first, with the cursor to save for the next run. */
  "activity.fetched": Schema.Struct({
    ...Sourced,
    authedUser: Schema.String,
    since: Schema.String,
    /** The newest item's ts, else `since`. */
    cursor: Schema.String,
    items: Schema.Array(Activity),
    threads: Schema.Array(Thread)
  }),
  /** One per new item Elysia flagged under Needs your attention, with its Slack text: ecard-slack-triage's input. */
  "item.fetched": Item,
  /** `source` is absent when there was nothing new to read. */
  "fetch.completed": Schema.Struct({ source: Schema.optionalKey(Source), fallbackReason: Sourced.fallbackReason, flagged: Schema.Int, fresh: Schema.Int, fetched: Schema.Int })
}

export class SeenError extends Schema.TaggedError<SeenError>()("SeenError", { message: Schema.String }) {}

/** Items per `fetch` run; the rest wait for the next run. One read covers them all. */
export const MAX_PER_RUN = 12
/** Permalinks per `activity` run. */
export const MAX_URLS = 20
const decodeSeen = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)))

const activity = job(events, {
  id: "activity",
  description:
    "Read Isaac's eCard Slack after `since` (ISO; default 24 h ago): DMs, group DMs, his channels and @-mentions of him, with reactions, plus the threads of `urls`. Claude proxy first, Slack desktop (CDP :9333) when it fails; `source` forces one. Read-only.",
  input: Schema.Struct({
    since: Schema.optionalKey(Schema.String),
    urls: Schema.optionalKey(Schema.Array(Schema.String)),
    source: Schema.optionalKey(SourceChoice)
  }),
  triggers: [Trigger.Manual()],
  run: Effect.fnUntraced(function*(input, ctx) {
    const since = input.since ?? new Date((yield* Clock.currentTimeMillis) - 86_400_000).toISOString()
    const read = yield* (yield* Slack).read({ since, urls: (input.urls ?? []).slice(0, MAX_URLS) }, input.source)
    const newest = read.items.reduce((max, item) => (Date.parse(item.ts) > Date.parse(max) ? item.ts : max), since)
    yield* ctx.emit("activity.fetched", { ...read, since, cursor: newest })
  })
})

const fetch = job(events, {
  id: "fetch",
  description: "Fetch the thread text of new Slack items Elysia flagged (read-only; claude proxy, else Slack desktop) and hand each to ecard-slack-triage.",
  input: Schema.Struct({ source: Schema.optionalKey(SourceChoice) }),
  triggers: [Trigger.Manual(), Trigger.Cron({ cron: "20 * * * *", input: Effect.succeed({}) })],
  run: Effect.fnUntraced(function*(input, ctx) {
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
    if (batch.length === 0) {
      yield* ctx.emit("fetch.completed", { flagged: flagged.length, fresh: 0, fetched: 0 })
      return
    }
    const read = yield* (yield* Slack).read({ urls: batch.map((item) => item.url) }, input.source)
    for (const item of batch) {
      const thread = read.threads.find((candidate) => candidate.url.split("?")[0] === item.url.split("?")[0])
      if (thread !== undefined && thread.messages.length > 0) yield* ctx.emit("item.fetched", { ...thread, url: item.url, summary: item.summary })
    }
    // Seen once tried: an item neither source could read is not retried every hour.
    const next = [...seen, ...batch.map((item) => item.url.split("?")[0]!)].slice(-500)
    yield* fs.writeFileString(`${file}.tmp`, `${JSON.stringify(next)}\n`).pipe(Effect.andThen(fs.rename(`${file}.tmp`, file)), Effect.mapError(seenError))
    yield* ctx.emit("fetch.completed", {
      source: read.source,
      ...(read.fallbackReason === undefined ? {} : { fallbackReason: read.fallbackReason }),
      flagged: flagged.length,
      fresh: fresh.length,
      fetched: read.threads.length
    })
  })
})

export const spec = {
  id: "ecard-slack-fetch",
  events,
  purpose: "Read Isaac's eCard Slack, read-only: what is new since a cursor (with reactions) and the threads of given or flagged permalinks; claude proxy first, Slack desktop as the fallback.",
  agent: {
    // No model calls: the fetch is a fixed read. Kept for the Component shape.
    model: "anthropic/claude-haiku-5-5",
    candidates: ["anthropic/claude-haiku-5-5"],
    system: ""
  },
  // `activity` first: `request` runs an agent's first manual job.
  jobs: [activity, fetch],
  tools: Layer.mergeAll(Slack.layer, Flags.layer)
} satisfies Component<Slack | Flags>

export default define(spec)
