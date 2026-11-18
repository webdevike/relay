import { Clock, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect"
import { type Component, define, job, Trigger } from "../../src/core/Component.ts"
import { ChefSurface, Item, Slack, Source, type Thread } from "./adapters/slack.ts"

/**
 * `kind: "code"` agent (`ecard-slack-digest.json`, next to this file): the slack triage chef's "Needs your attention".
 * No model. The only writer of `work/elysia/slack-chef.md` under Eva's checkout, which Eva's heartbeat and Catch Up read.
 * Each `ecard-slack-triage/item.triaged` updates the open list (kept in `open.json` in the state dir), keyed by
 * (conversation, thread): needs-isaac adds or replaces that line, skip removes it. Each run then rereads the other open
 * lines' threads through `Slack.threads` (read-only, the fetch's read path) and drops a line once Isaac wrote or reacted
 * at or after its message, or once that message is older than 14 days. Then it rewrites the file:
 * `_updated <ISO> · chef_`, `## Needs your attention`, one bullet per open line in the format Eva's heartbeat
 * (`sweep.ts`) and Catch Up (`catchup-build.ts`) parse. Never posts, reacts or marks anything read.
 */

export const MAX_AGE_MS = 14 * 86_400_000
/** Open lines reread per run (newest first); older ones wait, and age out. */
export const MAX_RECHECK = 20

export const Entry = Schema.Struct({
  /** `<channel id>:<thread ts>` (the message's own ts outside a thread). */
  key: Schema.String,
  url: Schema.String,
  /** `#name`, `DM with <name>` or `group DM`. */
  where: Schema.String,
  /** Group DM members or `thread`; absent otherwise. */
  who: Schema.optionalKey(Schema.String),
  author: Schema.String,
  /** ISO of the flagged message. */
  ts: Schema.String,
  gist: Schema.String,
  reason: Schema.String
})
export type Entry = typeof Entry.Type

const Triaged = Schema.Struct({
  ...Item.fields,
  verdict: Schema.Literals(["needs-isaac", "skip"]),
  isaacReplied: Schema.Boolean,
  reason: Schema.String,
  gist: Schema.optionalKey(Schema.String)
})

const Dropped = Schema.Struct({ url: Schema.String, why: Schema.Literals(["replied", "reacted", "stale"]) })

const events = {
  /** One per triaged item: what changed in `slack-chef.md` and what the recheck dropped. */
  "digest.written": Schema.Struct({
    file: Schema.String,
    change: Schema.Literals(["added", "replaced", "removed", "none"]),
    open: Schema.Int,
    dropped: Schema.Array(Dropped),
    source: Schema.optionalKey(Source),
    /** The recheck read failed: every open line was kept as it was. */
    recheckError: Schema.optionalKey(Schema.String)
  })
}

export class DigestError extends Schema.TaggedError<DigestError>()("DigestError", { message: Schema.String }) {}

/** `<channel id>:<thread ts>` of a permalink, or null when it is not one. */
export const keyOf = (url: string): string | null => {
  const link = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url)
  if (link === null) return null
  const thread = /[?&]thread_ts=(\d+\.\d+)/.exec(url)?.[1]
  return `${link[1]}:${thread ?? `${link[2]}.${link[3]}`}`
}

/** One line of text with none of the characters the readers split on (` · `, `[`, `]`). */
const clean = (text: string) => text.replace(/\s*·\s*/g, ", ").replace(/\s+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").trim()
/** ISO to the second, as Elysia writes it; a ts that is not a time stays as it is. */
const isoSecond = (ts: string) => (Number.isNaN(Date.parse(ts)) ? ts : new Date(Date.parse(ts)).toISOString().replace(/\.\d{3}Z$/, "Z"))

/** The open line for a needs-isaac item: its message is the one at the item's ts, else the newest. */
export const entryOf = (item: typeof Triaged.Type): Entry | null => {
  const key = keyOf(item.url)
  if (key === null) return null
  const at = Date.parse(item.ts)
  const message = item.messages.find((candidate) => Date.parse(candidate.ts) === at) ?? item.messages.at(-1)
  const group = /^group DM:\s*(.+)$/.exec(item.channel)
  const inThread = /[?&]thread_ts=/.test(item.url) && !item.channel.startsWith("DM") && group === null
  const where = group !== null ? "group DM" : clean(item.channel)
  const who = group !== null ? clean(group[1]!) : inThread ? "thread" : undefined
  return {
    key,
    url: item.url,
    where,
    ...(who === undefined ? {} : { who }),
    author: clean(message?.author ?? "unknown"),
    ts: isoSecond(message?.ts ?? item.ts),
    gist: clean(item.gist ?? item.reason),
    reason: clean(item.reason)
  }
}

/** `- **<where>** (<who>) · <author> · <ISO> · <gist> · why: <reason> [permalink](<url>)` */
export const lineOf = (entry: Entry) =>
  `- **${entry.where}**${entry.who === undefined ? "" : ` (${entry.who})`} · ${entry.author} · ${entry.ts} · ${entry.gist} · why: ${entry.reason} [permalink](${entry.url})`

export const render = (entries: ReadonlyArray<Entry>, now: string) =>
  [`_updated ${isoSecond(now)} · chef_`, "", "## Needs your attention", "", ...entries.map(lineOf), ""].join("\n")

/** Why an open line is done, from a fresh read of its thread: Isaac wrote or reacted at or after its message. */
export const handled = (entry: Entry, thread: Thread, isaac: string): "replied" | "reacted" | null => {
  const from = Date.parse(entry.ts)
  const after = thread.messages.filter((message) => Date.parse(message.ts) >= from)
  if (after.some((message) => message.author === isaac && Date.parse(message.ts) > from)) return "replied"
  const byIsaac = (reaction: string) => (reaction.split(" by ")[1] ?? "").split(",").some((name) => name.trim() === isaac)
  return after.some((message) => (message.reactions ?? []).some(byIsaac)) ? "reacted" : null
}

const decodeOpen = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Entry)))
/** One digest at a time: each run reads, changes and rewrites the same files. */
const lock = Semaphore.makeUnsafe(1)

const digest = job(events, {
  id: "digest",
  description:
    "Update Needs your attention in Eva's work/elysia/slack-chef.md from one triaged Slack item (needs-isaac adds or replaces its line, skip removes it), recheck the other open lines read-only and drop those Isaac answered or reacted to, or older than 14 days. Never posts, reacts or marks read.",
  input: Triaged,
  triggers: [Trigger.Manual(), Trigger.OnEvent({ type: "ecard-slack-triage/item.triaged" })],
  run: Effect.fnUntraced(function*(item, ctx) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const stateFile = path.join(ctx.stateDir, "open.json")
    const surface = yield* ChefSurface
    const failed = (where: string) => (error: { readonly message: string }) => new DigestError({ message: `${where}: ${error.message}` })
    yield* Effect.gen(function*() {
      const open: ReadonlyArray<Entry> = (yield* fs.exists(stateFile).pipe(Effect.mapError(failed(stateFile))))
        ? yield* fs.readFileString(stateFile).pipe(Effect.flatMap(decodeOpen), Effect.mapError(failed(stateFile)))
        : []
      const now = yield* Clock.currentTimeMillis
      const key = keyOf(item.url)
      const existed = open.some((entry) => entry.key === key)
      const others = open.filter((entry) => entry.key !== key)
      const added = item.verdict === "needs-isaac" ? entryOf(item) : null
      const change = added !== null ? (existed ? "replaced" : "added") : existed ? "removed" : "none"

      const dropped: Array<typeof Dropped.Type> = []
      const fresh = others.filter((entry) => {
        if (now - Date.parse(entry.ts) <= MAX_AGE_MS) return true
        dropped.push({ url: entry.url, why: "stale" })
        return false
      })
      const recheck = [...fresh].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, MAX_RECHECK)
      const result = recheck.length === 0 ? undefined : yield* Effect.result((yield* Slack).threads(recheck.map((entry) => entry.url)))
      const fetched = result?._tag === "Success" ? result.success : undefined
      const kept = fresh.filter((entry) => {
        const thread = fetched?.threads.find((candidate) => candidate.url === entry.url)
        const why = fetched === undefined || thread === undefined || thread.messages.length === 0 ? null : handled(entry, thread, fetched.authedUser)
        if (why !== null) dropped.push({ url: entry.url, why })
        return why === null
      })
      const next = [...kept, ...(added !== null && now - Date.parse(added.ts) <= MAX_AGE_MS ? [added] : [])]
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))

      yield* surface.write(render(next, new Date(now).toISOString()))
      yield* fs.writeFileString(`${stateFile}.tmp`, `${JSON.stringify(next, null, 2)}\n`).pipe(
        Effect.andThen(fs.rename(`${stateFile}.tmp`, stateFile)),
        Effect.mapError(failed(stateFile))
      )
      yield* ctx.emit("digest.written", {
        file: surface.file,
        change,
        open: next.length,
        dropped,
        ...(fetched === undefined ? {} : { source: fetched.source }),
        ...(result?._tag === "Failure" ? { recheckError: result.failure.message } : {})
      })
    }).pipe(lock.withPermit)
  })
})

export const spec = {
  id: "ecard-slack-digest",
  events,
  purpose:
    "Keep the slack triage chef's Needs your attention in Eva's work/elysia/slack-chef.md (read by Eva's heartbeat and Catch Up): needs-isaac adds a line per conversation thread, skip removes it, lines Isaac answered or reacted to (read-only recheck) or older than 14 days drop.",
  agent: {
    // No model calls. Kept for the Component shape.
    model: "anthropic/claude-haiku-5-5",
    candidates: ["anthropic/claude-haiku-5-5"],
    system: ""
  },
  jobs: [digest],
  tools: Layer.mergeAll(Slack.layer, ChefSurface.layer)
} satisfies Component<Slack | ChefSurface>

export default define(spec)
