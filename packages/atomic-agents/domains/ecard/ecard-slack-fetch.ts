import { Clock, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { type Advance, type Cluster, Cursor, Item, Slack, slackTs, Source, SourceChoice } from "./adapters/slack.ts"
import { type Component, define, job, Trigger } from "../../src/core/Component.ts"

/**
 * `kind: "code"` agent (`ecard-slack-fetch.json`, next to this file): Isaac's eCard Slack, read directly and read-only,
 * no model. Each `fetch` run scans what is new since the per-conversation cursors (`adapters/slack.ts` `Slack.scan`:
 * Slack desktop over CDP, the claude proxy when that fails): DMs and group DMs, @-mentions of Isaac, threads he is in and
 * the channels in `watch.json`, and hands each (conversation, thread) with something for him to ecard-slack-triage as
 * one `item.fetched`. State in the agent state dir:
 * - `cursor.json` (`Cursor`): newest Slack ts seen per conversation, per thread and of mentions. A missing key starts
 *   24 h back. Rewritten (tmp + rename) after each cluster, never past one not yet handed on, so a crash or the
 *   `MAX_PER_RUN` cut neither drops nor repeats an item.
 * - `watch.json`: `[{id, name?}]`, the channels read whole besides DMs, mentions and threads.
 */

const BySource = Schema.Struct({ dm: Schema.Int, mention: Schema.Int, thread: Schema.Int, channel: Schema.Int })

const events = {
  /** One (conversation, thread) with something for Isaac: ecard-slack-triage's input. */
  "item.fetched": Item,
  /** `skipped`: neither source could read Slack; every cursor stayed. */
  "fetch.completed": Schema.Struct({
    source: Schema.optionalKey(Source),
    /** Why the run left Slack desktop for the claude proxy. */
    fallbackReason: Schema.optionalKey(Schema.String),
    skipped: Schema.optionalKey(Schema.String),
    /** Clusters with something new for Isaac; `fetched` of them were handed on, `deferred` wait for the next run. */
    found: Schema.Int,
    fetched: Schema.Int,
    deferred: Schema.Int,
    bySource: BySource,
    /** Conversations that could not be read; their cursors stayed. */
    failures: Schema.Array(Schema.String)
  })
}

export class FetchStateError extends Schema.TaggedError<FetchStateError>()("FetchStateError", { message: Schema.String }) {}

/** Items per run; the rest wait for the next run. */
export const MAX_PER_RUN = 12
/** Thread cursors untouched this long are dropped. */
const THREAD_KEEP_MS = 14 * 86_400_000

export const Watch = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.String) }))
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))
const decodeWatch = Schema.decodeUnknownEffect(Schema.fromJsonString(Watch))

/**
 * The cursor once `done` clusters are handed on and `pending` are not: each key moves to the newest ts `done` covers,
 * but stays below the oldest ts a pending cluster needs for it.
 */
export const advanced = (cursor: Cursor, done: ReadonlyArray<Cluster>, pending: ReadonlyArray<Cluster>): Cursor => {
  const floor = new Map<string, string>()
  for (const advance of pending.flatMap((cluster) => cluster.advance)) {
    const held = floor.get(advance.key)
    if (held === undefined || advance.from < held) floor.set(advance.key, advance.from)
  }
  const next = { conv: { ...cursor.conv }, threads: { ...cursor.threads }, ...(cursor.mentions === undefined ? {} : { mentions: cursor.mentions }) }
  const move = (advance: Advance) => {
    const held = floor.get(advance.key)
    if (held !== undefined && advance.to >= held) return
    if (advance.key === "mentions") {
      if (next.mentions === undefined || advance.to > next.mentions) next.mentions = advance.to
      return
    }
    const [kind, ...rest] = advance.key.split(":")
    const map = kind === "conv" ? next.conv : next.threads
    const key = rest.join(":")
    if (map[key] === undefined || advance.to > map[key]!) map[key] = advance.to
  }
  for (const advance of done.flatMap((cluster) => cluster.advance)) move(advance)
  return next
}

/** Handed on first: mentions and DMs, then threads, then watched channels; oldest first within each. */
const RANK: Readonly<Record<Cluster["via"], number>> = { mention: 0, dm: 0, thread: 1, channel: 2 }
const firstTs = (cluster: Cluster) => cluster.advance.reduce((min, advance) => (advance.from < min ? advance.from : min), "9999999999.999999")

const fetch = job(events, {
  id: "fetch",
  description:
    "Read Isaac's eCard Slack directly since the per-conversation cursors (DMs, group DMs, @-mentions, threads he is in, watched channels; Slack desktop over CDP, the claude proxy when that fails; read-only) and hand each (conversation, thread) with something for him to ecard-slack-triage.",
  input: Schema.Struct({ source: Schema.optionalKey(SourceChoice) }),
  triggers: [Trigger.Manual(), Trigger.Cron({ cron: "20 * * * *", input: Effect.succeed({}) })],
  run: Effect.fnUntraced(function*(input, ctx) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const cursorFile = path.join(ctx.stateDir, "cursor.json")
    const watchFile = path.join(ctx.stateDir, "watch.json")
    const failed = (file: string) => (error: { readonly message: string }) => new FetchStateError({ message: `${file}: ${error.message}` })
    const load = <A>(file: string, decode: (text: string) => Effect.Effect<A, { readonly message: string }>, empty: A) =>
      fs.exists(file).pipe(
        Effect.flatMap((exists) => (exists ? fs.readFileString(file).pipe(Effect.flatMap(decode)) : Effect.succeed(empty))),
        Effect.mapError(failed(file))
      )
    let cursor: Cursor = yield* load(cursorFile, decodeCursor, { conv: {}, threads: {} })
    const watch = yield* load(watchFile, decodeWatch, [])
    const now = yield* Clock.currentTimeMillis
    const bySource = { dm: 0, mention: 0, thread: 0, channel: 0 }

    const result = yield* Effect.result((yield* Slack).scan({ cursor, watch: watch.map((channel) => channel.id), floor: slackTs(now - 86_400_000) }, input.source))
    if (result._tag === "Failure") {
      yield* ctx.emit("fetch.completed", { skipped: result.failure.message, found: 0, fetched: 0, deferred: 0, bySource, failures: [] })
      return
    }
    const scan = result.success
    const ordered = [...scan.clusters].sort((a, b) => RANK[a.via] - RANK[b.via] || (firstTs(a) < firstTs(b) ? -1 : firstTs(a) > firstTs(b) ? 1 : 0))
    const found = ordered.filter((cluster) => cluster.emit).length
    const keepThreads = slackTs(now - THREAD_KEEP_MS)
    let fetched = 0
    let at = 0
    for (; at < ordered.length; at++) {
      const cluster = ordered[at]!
      if (cluster.emit) {
        if (fetched === MAX_PER_RUN) break
        const operative = cluster.messages.find((message) => message.ts === cluster.ts) ?? cluster.messages[cluster.messages.length - 1]
        yield* ctx.emit("item.fetched", {
          url: cluster.url,
          channel: cluster.channel,
          ts: cluster.ts,
          summary: `${cluster.channel} · ${operative?.author ?? "unknown"} · ${cluster.ts}`,
          messages: cluster.messages
        })
        fetched++
        bySource[cluster.via]++
      }
      const next = advanced(cursor, ordered.slice(0, at + 1), ordered.slice(at + 1))
      const threads = Object.fromEntries(Object.entries(next.threads).filter(([, ts]) => ts >= keepThreads))
      const pruned = { ...next, threads }
      if (JSON.stringify(pruned) === JSON.stringify(cursor)) continue
      cursor = pruned
      yield* fs.writeFileString(`${cursorFile}.tmp`, `${JSON.stringify(cursor, null, 2)}\n`).pipe(
        Effect.andThen(fs.rename(`${cursorFile}.tmp`, cursorFile)),
        Effect.mapError(failed(cursorFile))
      )
    }
    yield* ctx.emit("fetch.completed", {
      source: scan.source,
      ...(scan.fallbackReason === undefined ? {} : { fallbackReason: scan.fallbackReason }),
      found,
      fetched,
      deferred: found - fetched,
      bySource,
      failures: scan.failures
    })
  })
})

export const spec = {
  id: "ecard-slack-fetch",
  events,
  purpose:
    "Read Isaac's eCard Slack directly, read-only: DMs, group DMs, @-mentions, threads he is in and watched channels since per-conversation cursors, one item per conversation thread for ecard-slack-triage; Slack desktop first, the claude proxy as the fallback.",
  agent: {
    // No model calls: the fetch is a fixed read. Kept for the Component shape.
    model: "anthropic/claude-haiku-5-5",
    candidates: ["anthropic/claude-haiku-5-5"],
    system: ""
  },
  jobs: [fetch],
  tools: Slack.layer
} satisfies Component<Slack>

export default define(spec)
