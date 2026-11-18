import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { EvaRoot } from "../../../src/core/adapters/eva.ts"
import { exec } from "../../../src/core/exec.ts"

/**
 * Slack, read-only, for the eCard agents, from two sources with the same output:
 * - `slack-desktop` (default): Isaac's signed-in Slack desktop app over CDP (:9333, launched with
 *   `--remote-debugging-port=9333 --user-data-dir=.../Slack-cdp`). One `Runtime.evaluate` in the client page calls
 *   read-only Web API methods (`READ_METHODS`, an allowlist) with the client's own session; the token never leaves the
 *   page, and it never navigates, clicks, types, sends, reacts or marks anything read.
 * - `claude-proxy` (fallback): `claude -p` with the claude.ai Slack connector (its tool list is the connector, every
 *   built-in is disallowed, the prompt forbids posting, reacting and marking read).
 * `auto` reads from the desktop app and, when that fails (CDP down, not signed in, error, timeout, unreadable output),
 * reads the same request through the proxy; the answer names the source it came from and why it fell back.
 *
 * Two reads: `scan` (what is new since the per-conversation cursors, as one cluster per conversation thread, for
 * ecard-slack-fetch) and `threads` (the conversations of given permalinks, for ecard-slack-digest's recheck).
 */

export const Message = Schema.Struct({
  author: Schema.String,
  ts: Schema.String,
  text: Schema.String,
  reactions: Schema.optionalKey(Schema.Array(Schema.String))
})

export const Item = Schema.Struct({
  url: Schema.String,
  channel: Schema.String,
  ts: Schema.String,
  /** `<where> · <author> · <ISO>` of the operative message. */
  summary: Schema.String,
  /** The thread, or the message with the ones around it, in time order. */
  messages: Schema.Array(Message)
})
export type Item = typeof Item.Type

/** A permalink's conversation: the thread, else the linked message and the 8 after it, in time order (ISO `ts`). */
export const Thread = Schema.Struct({ url: Schema.String, channel: Schema.String, ts: Schema.String, messages: Schema.Array(Message) })
export type Thread = typeof Thread.Type

export const Threads = Schema.Struct({
  /** The Slack user the source is signed in as; empty means it never reached Slack. */
  authedUser: Schema.String,
  threads: Schema.Array(Thread)
})
export type Threads = typeof Threads.Type

/** Where a cluster came from: a DM or group DM, an @-mention of Isaac, a thread he is in, or a watched channel. */
export const Via = Schema.Literals(["dm", "mention", "thread", "channel"])
export type Via = typeof Via.Type

/**
 * One cursor a cluster moves: `conv:<channel>`, `thread:<channel>:<thread ts>` or `mentions`, over the Slack ts
 * range `from`..`to` it covers (raw `1795032370.584599` form).
 */
export const Advance = Schema.Struct({ key: Schema.String, from: Schema.String, to: Schema.String })
export type Advance = typeof Advance.Type

/** One (conversation, thread) with something new since its cursor. */
export const Cluster = Schema.Struct({
  /** `<channel>:<thread ts>`; a DM's or group DM's top level is `<channel>:` plus its operative ts. */
  key: Schema.String,
  via: Via,
  /** Permalink of the operative message: the newest one not by Isaac (else the newest). */
  url: Schema.String,
  /** `#name`, `DM with <name>` or `group DM: <names>`. */
  channel: Schema.String,
  /** ISO of the operative message. */
  ts: Schema.String,
  /** False when only Isaac, bots or join/leave/edit events are new, or Isaac wrote after the operative message. */
  emit: Schema.Boolean,
  messages: Schema.Array(Message),
  advance: Schema.Array(Advance)
})
export type Cluster = typeof Cluster.Type

export const Scan = Schema.Struct({
  authedUser: Schema.String,
  clusters: Schema.Array(Cluster),
  /** Conversations that could not be read this run; their cursors stay. */
  failures: Schema.Array(Schema.String)
})
export type Scan = typeof Scan.Type

/** `ctx.stateDir/cursor.json` of ecard-slack-fetch: newest Slack ts seen per conversation, per thread, and of @-mentions. */
export const Cursor = Schema.Struct({
  conv: Schema.Record(Schema.String, Schema.String),
  threads: Schema.Record(Schema.String, Schema.String),
  mentions: Schema.optionalKey(Schema.String)
})
export type Cursor = typeof Cursor.Type

/** What to scan: everything after each cursor (a missing key starts at `floor`), plus the `watch` channels. */
export interface ScanRequest {
  readonly cursor: Cursor
  readonly watch: ReadonlyArray<string>
  /** Raw Slack ts a missing cursor key starts from (24 h back). */
  readonly floor: string
}

export const Source = Schema.Literals(["slack-desktop", "claude-proxy"])
export type Source = typeof Source.Type
/** `auto`: the desktop app, then the proxy when it fails. A source by name: that one only. */
export const SourceChoice = Schema.Literals(["auto", "slack-desktop", "claude-proxy"])
export type SourceChoice = typeof SourceChoice.Type

export type Sourced<A> = A & {
  readonly source: Source
  /** Why `auto` left the desktop app for the proxy. */
  readonly fallbackReason?: string
}

export class SlackError extends Schema.TaggedError<SlackError>()("SlackError", { message: Schema.String }) {}

/** One way to read Slack. */
export interface Reader {
  readonly scan: (request: ScanRequest) => Effect.Effect<Scan, SlackError>
  readonly threads: (urls: ReadonlyArray<string>) => Effect.Effect<Threads, SlackError>
}

const TEAM = "T0LS0H1CG"
/** Messages around a non-thread operative message, each side. */
const CONTEXT = 8
/** Threads Isaac wrote in during this many days are rechecked for new replies. */
const THREAD_DAYS = 7
/** Thread messages handed on: the parent and the newest replies. */
const THREAD_TAIL = 30
/** Proxy fallback: activity items per read, newest first; DMs and mentions of Isaac are kept before channel chatter. */
export const MAX_ITEMS = 150

/** Raw Slack ts (`1795032370.584599`) of a time in ms; raw ts compare as strings. */
export const slackTs = (ms: number) => `${Math.floor(ms / 1000)}.000000`
const isoOf = (ts: string) => new Date(Number(ts) * 1000).toISOString()

const decodeOrFail = <S extends Schema.Decoder<{ readonly authedUser: string }>>(schema: S, source: Source) => {
  const decode = Schema.decodeUnknownEffect(schema)
  return (value: unknown) =>
    decode(value).pipe(
      Effect.mapError((error) => new SlackError({ message: `${source} output: ${error.message}` })),
      Effect.filterOrFail(
        (read) => read.authedUser.trim() !== "",
        () => new SlackError({ message: `${source}: no authed Slack user (not signed in?)` })
      )
    )
}

// ---------------------------------------------------------------------------------------------------------------
// Slack desktop

/** The Web API methods the desktop reader may call: reads only. Anything else is a defect. */
export const READ_METHODS = ["auth.test", "users.conversations", "users.info", "conversations.history", "conversations.replies", "conversations.info", "search.messages"]

interface SlackMessage {
  readonly ts: string
  readonly user?: string
  readonly username?: string
  readonly subtype?: string
  readonly bot_id?: string
  readonly bot_profile?: { readonly name?: string }
  readonly thread_ts?: string
  readonly text?: string
  readonly attachments?: ReadonlyArray<{ readonly fallback?: string }>
  readonly reply_count?: number
  readonly reactions?: ReadonlyArray<{ readonly name: string; readonly count: number; readonly users?: ReadonlyArray<string> }>
}
interface SlackConversation {
  readonly id: string
  readonly name?: string
  readonly is_im?: boolean
  readonly is_mpim?: boolean
  readonly user?: string
  readonly members?: ReadonlyArray<string>
}
interface SearchMatch extends SlackMessage {
  readonly channel: SlackConversation
  readonly permalink: string
}
interface PageCluster {
  key: string
  merge: string
  via: Via
  url: string
  channel: string
  ts: string
  emit: boolean
  messages: ReadonlyArray<typeof Message.Type>
  advance: Array<Advance>
}

type PageArgs =
  | { readonly mode: "threads"; readonly team: string; readonly methods: ReadonlyArray<string>; readonly urls: ReadonlyArray<string> }
  | {
    readonly mode: "scan"
    readonly team: string
    readonly methods: ReadonlyArray<string>
    readonly cursor: Cursor
    readonly watch: ReadonlyArray<string>
    readonly floor: string
    readonly threadDays: number
    readonly context: number
    readonly threadTail: number
  }

/**
 * Runs INSIDE the Slack client page (serialized with `toString`, so it may use only browser globals and its argument):
 * read-only Web API calls with the signed-in client's session, through `methods` only.
 */
const inSlackPage = async (args: PageArgs) => {
  // The client keeps its per-team session token in localStorage; it never leaves the page.
  const token: unknown = JSON.parse(localStorage.getItem("localConfig_v2") ?? "{}")?.teams?.[args.team]?.token
  if (typeof token !== "string") throw new Error(`Slack desktop is not signed in to team ${args.team}`)
  const api = async <A>(method: string, params: Record<string, string | number | boolean> = {}): Promise<A> => {
    if (!args.methods.includes(method)) throw new Error(`${method} is not a read method`)
    const body = new FormData()
    body.append("token", token)
    for (const [key, value] of Object.entries(params)) body.append(key, String(value))
    const response = await fetch(`/api/${method}`, { method: "POST", body, credentials: "include" })
    const json: { ok?: unknown; error?: unknown } = await response.json()
    if (json.ok !== true) throw new Error(`${method}: ${String(json.error ?? `HTTP ${response.status}`)}`)
    // The read methods' documented shapes; the answer is validated whole once it leaves the page.
    return json as A
  }
  const pool = async <A, B>(all: ReadonlyArray<A>, run: (one: A) => Promise<B>) => {
    const out: Array<B> = []
    for (let at = 0; at < all.length; at += 4) out.push(...(await Promise.all(all.slice(at, at + 4).map(run))))
    return out
  }
  const iso = (ts: string) => new Date(Number(ts) * 1000).toISOString()
  const me = await api<{ user_id: string; url?: string }>("auth.test")
  const isaac = me.user_id
  const base = (me.url ?? "https://ecardplatform.slack.com/").replace(/\/$/, "")
  const names = new Map<string, Promise<string>>()
  const name = (id: string | undefined, fallback: string) => {
    if (id === undefined) return Promise.resolve(fallback)
    let found = names.get(id)
    if (found === undefined) {
      found = api<{ user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } }>("users.info", { user: id }).then(
        ({ user }) => user?.profile?.real_name || user?.real_name || user?.profile?.display_name || user?.name || fallback,
        () => fallback
      )
      names.set(id, found)
    }
    return found
  }
  const authedUser = await name(isaac, isaac)
  const readable = async (message: SlackMessage, max: number) => {
    let text = message.text || message.attachments?.map((attachment) => attachment.fallback ?? "").join(" ") || ""
    for (const id of new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((match) => match[1]!))) text = text.replaceAll(`<@${id}>`, `@${await name(id, id)}`)
    return text.replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1").replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)").replace(/<(https?:[^>]+)>/g, "$1").slice(0, max)
  }
  const shown = async (message: SlackMessage) => {
    const reactions = []
    for (const reaction of message.reactions ?? []) {
      reactions.push(`:${reaction.name}: by ${(await Promise.all((reaction.users ?? []).map((user) => name(user, user)))).join(", ")}`)
    }
    return {
      author: await name(message.user, message.username ?? message.bot_profile?.name ?? "unknown"),
      ts: iso(message.ts),
      text: await readable(message, 400),
      ...(reactions.length === 0 ? {} : { reactions })
    }
  }
  const known = new Map<string, SlackConversation>()
  const labels = new Map<string, Promise<{ label: string; kind: "dm" | "group_dm" | "channel" }>>()
  const conversation = (id: string, hint?: SlackConversation) => {
    let found = labels.get(id)
    if (found === undefined) {
      found = (async () => {
        const conv = known.get(id) ?? (hint?.is_im !== undefined ? hint : (await api<{ channel: SlackConversation }>("conversations.info", { channel: id })).channel)
        if (conv.is_im) return { label: `DM with ${await name(conv.user, conv.user ?? "someone")}`, kind: "dm" as const }
        if (conv.is_mpim) {
          const others = await Promise.all((conv.members ?? []).filter((member) => member !== isaac).map((member) => name(member, member)))
          return { label: `group DM: ${others.length > 0 ? others.join(", ") : (conv.name ?? id)}`, kind: "group_dm" as const }
        }
        return { label: `#${conv.name ?? id}`, kind: "channel" as const }
      })()
      labels.set(id, found)
    }
    return found
  }
  const history = (channel: string, params: Record<string, string | number | boolean>) =>
    api<{ messages: ReadonlyArray<SlackMessage> }>("conversations.history", { channel, ...params }).then(({ messages }) => [...messages].reverse())
  const replies = (channel: string, ts: string) =>
    api<{ messages: ReadonlyArray<SlackMessage> }>("conversations.replies", { channel, ts, limit: 200 }).then(({ messages }) => messages)

  if (args.mode === "threads") {
    const threads = []
    for (const url of args.urls) {
      const link = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url)
      if (link === null) continue
      const channel = link[1]!
      const ts = `${link[2]}.${link[3]}`
      const threadTs = new URL(url).searchParams.get("thread_ts")
      let messages: ReadonlyArray<SlackMessage>
      if (threadTs !== null) {
        messages = await replies(channel, threadTs)
      } else {
        // `oldest` alone returns the messages nearest it: the linked one and the 8 after it.
        const after = await history(channel, { oldest: ts, inclusive: true, limit: 9 })
        messages = (after[0]?.reply_count ?? 0) > 0 ? await replies(channel, ts) : after
      }
      const out = []
      for (const message of messages) out.push(await shown(message))
      threads.push({ url, channel: (await conversation(channel)).label, ts: iso(ts), messages: out })
    }
    return { authedUser, threads }
  }

  const failures: Array<string> = []
  const clusters: Array<PageCluster> = []
  const KEPT_SUBTYPES = ["thread_broadcast", "file_share", "me_message"]
  /** A bot, an app or a join/leave/edit event: never an item. */
  const noise = (message: SlackMessage) =>
    message.user === undefined || message.bot_id !== undefined || (message.subtype !== undefined && !KEPT_SUBTYPES.includes(message.subtype))
  const permalink = (channel: string, ts: string, threadTs?: string) =>
    `${base}/archives/${channel}/p${ts.replace(".", "")}${threadTs !== undefined && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${channel}` : ""}`
  /** The newest message that is not Isaac's or noise among `fresh`, and whether Isaac wrote after it in `all`. */
  const operative = (fresh: ReadonlyArray<SlackMessage>, all: ReadonlyArray<SlackMessage>) => {
    const op = [...fresh].reverse().find((message) => !noise(message) && message.user !== isaac)
    const answered = op !== undefined && all.some((message) => message.user === isaac && message.ts > op.ts)
    return { op, emit: op !== undefined && !answered }
  }
  const around = (all: ReadonlyArray<SlackMessage>, ts: string) => {
    const at = Math.max(0, all.findIndex((message) => message.ts === ts))
    return all.slice(Math.max(0, at - args.context), at + args.context + 1)
  }
  const threadOf = (all: ReadonlyArray<SlackMessage>) => (all.length <= args.threadTail + 1 ? all : [all[0]!, ...all.slice(-args.threadTail)])
  const showAll = async (messages: ReadonlyArray<SlackMessage>) => {
    const out = []
    for (const message of messages) out.push(await shown(message))
    return out
  }
  const add = async (cluster: Omit<PageCluster, "messages">, messages: ReadonlyArray<SlackMessage>) =>
    clusters.push({ ...cluster, messages: await showAll(messages) })

  // DMs, group DMs and watched channels: everything after each conversation's cursor.
  const direct: Array<SlackConversation> = []
  let page = ""
  do {
    const listed = await api<{ channels: ReadonlyArray<SlackConversation>; response_metadata?: { next_cursor?: string } }>("users.conversations", {
      types: "im,mpim",
      exclude_archived: true,
      limit: 1000,
      ...(page === "" ? {} : { cursor: page })
    })
    direct.push(...listed.channels)
    page = listed.response_metadata?.next_cursor ?? ""
  } while (page !== "")
  for (const conv of direct) known.set(conv.id, conv)
  const scanned = [...new Set([...direct.map((conv) => conv.id), ...args.watch])]
  await pool(scanned, async (id) => {
    const oldest = args.cursor.conv[id] ?? args.floor
    try {
      // `oldest` alone returns the earliest messages after it; the rest wait for the next run.
      const fresh = await history(id, { oldest, limit: 200 })
      if (fresh.length === 0) return
      const where = await conversation(id)
      if (where.kind !== "channel") {
        const before = await history(id, { latest: fresh[0]!.ts, limit: args.context })
        const all = [...before, ...fresh]
        const { op, emit } = operative(fresh, all)
        const at = op ?? fresh[fresh.length - 1]!
        await add({
          key: `${id}:${at.ts}`,
          merge: `${id}:top`,
          via: "dm",
          url: permalink(id, at.ts),
          channel: where.label,
          ts: iso(at.ts),
          emit,
          advance: [{ key: `conv:${id}`, from: fresh[0]!.ts, to: fresh[fresh.length - 1]!.ts }]
        }, around(all, at.ts))
        return
      }
      // A channel: each top-level message is its own thread.
      const before = await history(id, { latest: fresh[0]!.ts, limit: args.context })
      const all = [...before, ...fresh]
      for (const message of fresh) {
        const thread = (message.reply_count ?? 0) > 0 ? await replies(id, message.ts) : undefined
        await add({
          key: `${id}:${message.ts}`,
          merge: `${id}:${message.ts}`,
          via: "channel",
          url: permalink(id, message.ts),
          channel: where.label,
          ts: iso(message.ts),
          emit: !noise(message) && message.user !== isaac && !(thread ?? []).some((reply) => reply.user === isaac),
          advance: [{ key: `conv:${id}`, from: message.ts, to: message.ts }]
        }, thread === undefined ? around(all, message.ts) : threadOf(thread))
      }
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  const search = async (query: string, pages: number, until: string) => {
    const found: Array<SearchMatch> = []
    for (let at = 1; at <= pages; at++) {
      const result = await api<{ messages?: { matches?: ReadonlyArray<SearchMatch>; paging?: { pages?: number } } }>("search.messages", {
        query,
        sort: "timestamp",
        sort_dir: "desc",
        count: 100,
        page: at
      })
      const matches = result.messages?.matches ?? []
      found.push(...matches.filter((match) => match.ts > until))
      if (matches.length === 0 || matches[matches.length - 1]!.ts <= until || at >= (result.messages?.paging?.pages ?? 1)) break
    }
    return found
  }
  const threadTsOf = (match: SearchMatch) => new URL(match.permalink).searchParams.get("thread_ts") ?? undefined

  // @-mentions of Isaac anywhere, after the mentions cursor.
  try {
    const since = args.cursor.mentions ?? args.floor
    const mentions = (await search(`<@${isaac}>`, 2, since)).filter((match) => match.user !== isaac)
    const groups = new Map<string, Array<SearchMatch>>()
    for (const match of mentions) {
      const threadTs = threadTsOf(match)
      const key = `${match.channel.id}:${threadTs ?? match.ts}`
      groups.set(key, [...(groups.get(key) ?? []), match])
    }
    await pool([...groups.entries()], async ([key, group]) => {
      const newest = group.reduce((max, match) => (match.ts > max.ts ? match : max))
      const channel = newest.channel.id
      const threadTs = threadTsOf(newest)
      try {
        const where = await conversation(channel, newest.channel)
        const messages = threadTs !== undefined
          ? threadOf(await replies(channel, threadTs))
          : [...(await history(channel, { latest: newest.ts, inclusive: true, limit: args.context + 1 })), ...(await history(channel, { oldest: newest.ts, limit: args.context }))]
        const { op, emit } = operative(messages.filter((message) => message.ts === newest.ts), messages)
        const tsList = group.map((match) => match.ts).sort()
        await add({
          key,
          merge: threadTs === undefined && where.kind !== "channel" ? `${channel}:top` : key,
          via: "mention",
          url: permalink(channel, newest.ts, threadTs),
          channel: where.label,
          ts: iso(newest.ts),
          emit: op === undefined ? !noise(newest) : emit,
          advance: [{ key: "mentions", from: tsList[0]!, to: tsList[tsList.length - 1]! }]
        }, messages)
      } catch (error) {
        failures.push(`mention ${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    failures.push(`mentions: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Threads Isaac started or replied in during the last `threadDays`, plus those already on the cursor: new replies.
  try {
    const day = new Date(Date.now() - (args.threadDays + 1) * 86_400_000).toISOString().slice(0, 10)
    const since = `${Math.floor(Date.now() / 1000 - args.threadDays * 86_400)}.000000`
    const wrote = await search(`from:<@${isaac}> after:${day}`, 3, since)
    const threads = new Map<string, { channel: string; threadTs: string; hint?: SlackConversation }>()
    for (const key of Object.keys(args.cursor.threads)) {
      const [channel, threadTs] = key.split(":")
      if (channel !== undefined && threadTs !== undefined) threads.set(key, { channel, threadTs })
    }
    for (const match of wrote) {
      const threadTs = threadTsOf(match) ?? (match.channel.is_im === true ? undefined : match.ts)
      if (threadTs !== undefined) threads.set(`${match.channel.id}:${threadTs}`, { channel: match.channel.id, threadTs, hint: match.channel })
    }
    await pool([...threads.entries()], async ([key, { channel, threadTs, hint }]) => {
      try {
        const oldest = args.cursor.threads[key] ?? args.floor
        const all = await replies(channel, threadTs)
        const fresh = all.filter((message) => message.ts !== threadTs && message.ts > oldest)
        if (fresh.length === 0) return
        const where = await conversation(channel, hint)
        const { op, emit } = operative(fresh, all)
        const at = op ?? fresh[fresh.length - 1]!
        await add({
          key,
          merge: key,
          via: "thread",
          url: permalink(channel, at.ts, threadTs),
          channel: where.label,
          ts: iso(at.ts),
          emit,
          advance: [{ key: `thread:${key}`, from: fresh[0]!.ts, to: fresh[fresh.length - 1]!.ts }]
        }, threadOf(all))
      } catch (error) {
        failures.push(`thread ${key}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    failures.push(`threads: ${error instanceof Error ? error.message : String(error)}`)
  }

  // One cluster per (conversation, thread): a mention inside a DM, thread or watched channel post joins it.
  const VIA_RANK = { mention: 0, dm: 1, thread: 2, channel: 3 }
  const merged = new Map<string, PageCluster>()
  for (const cluster of clusters) {
    const other = merged.get(cluster.merge)
    if (other === undefined) {
      merged.set(cluster.merge, cluster)
      continue
    }
    const [newer, older] = cluster.ts > other.ts ? [cluster, other] : [other, cluster]
    merged.set(cluster.merge, {
      ...newer,
      via: VIA_RANK[cluster.via] < VIA_RANK[other.via] ? cluster.via : other.via,
      emit: newer.emit,
      advance: [...newer.advance, ...older.advance]
    })
  }
  return { authedUser, clusters: [...merged.values()].map(({ merge: _merge, ...cluster }) => cluster), failures }
}

const Targets = Schema.Array(Schema.Struct({ type: Schema.String, url: Schema.String, webSocketDebuggerUrl: Schema.optionalKey(Schema.String) }))
const decodeTargets = Schema.decodeUnknownSync(Targets)
const CdpReply = Schema.Struct({
  id: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
  result: Schema.optionalKey(Schema.Struct({
    result: Schema.optionalKey(Schema.Struct({ value: Schema.optionalKey(Schema.Unknown) })),
    exceptionDetails: Schema.optionalKey(Schema.Struct({ text: Schema.optionalKey(Schema.String), exception: Schema.optionalKey(Schema.Struct({ description: Schema.optionalKey(Schema.String) })) }))
  }))
})
const decodeCdpReply = Schema.decodeUnknownOption(Schema.fromJsonString(CdpReply))

/** Evaluates `inSlackPage(args)` in the `app.slack.com/client` page on `cdp` and returns its value. */
const evaluate = (cdp: string, args: PageArgs) =>
  Effect.tryPromise({
    try: async (signal) => {
      const targets = decodeTargets(await (await fetch(`${cdp}/json/list`, { signal })).json())
      const page = targets.find((target) => target.type === "page" && target.url.includes("app.slack.com/client"))
      if (page?.webSocketDebuggerUrl === undefined) throw new Error(`no app.slack.com/client page on ${cdp}`)
      const socket = new WebSocket(page.webSocketDebuggerUrl)
      try {
        return await new Promise<unknown>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")))
          socket.onerror = () => reject(new Error(`CDP socket error on ${cdp}`))
          socket.onclose = () => reject(new Error("CDP socket closed"))
          socket.onmessage = (message) => {
            const decoded = decodeCdpReply(String(message.data))
            if (decoded._tag === "None" || decoded.value.id !== 1) return
            const reply = decoded.value
            const failure = reply.error?.message ?? reply.result?.exceptionDetails?.exception?.description ?? reply.result?.exceptionDetails?.text
            if (failure !== undefined) reject(new Error(failure.split("\n")[0]))
            else resolve(reply.result?.result?.value)
          }
          socket.onopen = () =>
            socket.send(JSON.stringify({
              id: 1,
              method: "Runtime.evaluate",
              params: { expression: `(${inSlackPage.toString()})(${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }
            }))
        })
      } finally {
        socket.onclose = null
        socket.close()
      }
    },
    catch: (error) => new SlackError({ message: `slack desktop: ${error instanceof Error ? error.message : String(error)}` })
  }).pipe(Effect.timeoutOrElse({ duration: "4 minutes", orElse: () => Effect.fail(new SlackError({ message: "slack desktop timed out after 4 minutes" })) }))

/** Slack desktop over CDP. */
export const desktopReader = (cdp: string): Reader => ({
  scan: (request) =>
    evaluate(cdp, {
      mode: "scan",
      team: TEAM,
      methods: READ_METHODS,
      cursor: request.cursor,
      watch: request.watch,
      floor: request.floor,
      threadDays: THREAD_DAYS,
      context: CONTEXT,
      threadTail: THREAD_TAIL
    }).pipe(Effect.flatMap(decodeOrFail(Scan, "slack-desktop"))),
  threads: (urls) => evaluate(cdp, { mode: "threads", team: TEAM, methods: READ_METHODS, urls }).pipe(Effect.flatMap(decodeOrFail(Threads, "slack-desktop")))
})

// ---------------------------------------------------------------------------------------------------------------
// claude proxy (fallback)

export const Reaction = Schema.Struct({ emoji: Schema.String, count: Schema.Int, byIsaac: Schema.Boolean })

/** The proxy's activity read: one message posted after `since` in a DM, group DM or channel of Isaac's, or one that @-mentions him. */
export const Activity = Schema.Struct({
  url: Schema.String,
  /** `#name`, `DM with <name>` or `group DM: <names>`. */
  channel: Schema.String,
  kind: Schema.Literals(["dm", "group_dm", "channel"]),
  author: Schema.String,
  /** ISO 8601 UTC. */
  ts: Schema.String,
  text: Schema.String,
  /** ISO of the thread's parent when this is a thread reply. */
  threadTs: Schema.optionalKey(Schema.String),
  mentionsIsaac: Schema.Boolean,
  reactions: Schema.Array(Reaction)
})
export type Activity = typeof Activity.Type

const ProxyRead = Schema.Struct({ authedUser: Schema.String, items: Schema.Array(Activity), threads: Schema.Array(Thread) })

const proxyPrompt = (request: { readonly since?: string; readonly urls: ReadonlyArray<string> }) =>
  [
    "READ-ONLY. Never post, reply, react or mark anything read. Use only the Slack tools; Isaac Weber is the authed user.",
    request.since === undefined
      ? "items: []."
      : `items: every message posted after ${request.since} (UTC) in Isaac's DMs (1:1 and group DMs) and the channels he is a member of, thread replies included, plus any message anywhere that @-mentions him. Read in detailed mode so you see reactions. Newest first, at most ${MAX_ITEMS}; keep DMs and mentions of him before channel messages.`,
    request.urls.length === 0
      ? "threads: []."
      : "threads: for each Slack permalink below, if it is in a thread read the whole thread, otherwise that message plus the 8 messages after it in the same conversation.",
    "Output ONLY one JSON object (no prose, no code fence):",
    `{"authedUser": "<the connector's authed user, display name>", "items": [{"url": "<permalink>", "channel": "<#name, DM with <name>, or group DM: <names>>", "kind": "dm" | "group_dm" | "channel", "author": "<display name>", "ts": "<ISO 8601 UTC>", "text": "<max 600 chars>", "threadTs": "<ISO 8601 UTC of the thread parent; only on a thread reply>", "mentionsIsaac": true | false, "reactions": [{"emoji": "<name>", "count": <n>, "byIsaac": true | false}]}], "threads": [{"url": "<permalink as given>", "channel": "<as above>", "ts": "<ISO 8601 UTC of the linked message>", "messages": [{"author": "<display name>", "ts": "<ISO 8601 UTC>", "text": "<max 400 chars>", "reactions": ["<emoji> by <names>"]}]}]}.`,
    "threads messages include the linked message and are in time order. If the Slack tools are missing, not signed in or fail, output ONLY {\"error\": \"<why>\"}.",
    ...(request.urls.length === 0 ? [] : ["Permalinks:", ...request.urls])
  ].join("\n")

const proxyRead = (claude: string, spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) => (request: { readonly since?: string; readonly urls: ReadonlyArray<string> }) =>
  exec(claude, [
    "-p", proxyPrompt(request),
    "--allowedTools", "mcp__claude_ai_Slack",
    "--permission-mode", "dontAsk",
    "--disallowedTools", "Bash Read Write Edit Glob Grep WebFetch WebSearch Task NotebookEdit"
  ]).pipe(
    Effect.timeoutOrElse({ duration: "8 minutes", orElse: () => Effect.fail(new SlackError({ message: "claude proxy timed out after 8 minutes" })) }),
    Effect.catchTag("PlatformError", (error) => Effect.fail(new SlackError({ message: `claude proxy: ${error.message}` }))),
    Effect.flatMap((result) => {
      const text = result.stdout
      const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
      const said = (result.stderr || text).trim().slice(-300)
      if (result.exitCode !== 0) return Effect.fail(new SlackError({ message: `claude proxy exited ${result.exitCode}${said === "" ? "" : `: ${said}`}` }))
      if (json === "") return Effect.fail(new SlackError({ message: `claude proxy printed no JSON: ${said}` }))
      return Effect.try({ try: (): unknown => JSON.parse(json), catch: () => new SlackError({ message: `claude proxy output is not JSON: ${json.slice(0, 200)}` }) }).pipe(
        Effect.flatMap((value) =>
          typeof value === "object" && value !== null && "error" in value
            ? Effect.fail(new SlackError({ message: `claude proxy: ${String(value.error).slice(0, 300)}` }))
            : decodeOrFail(ProxyRead, "claude-proxy")(value)
        )
      )
    }),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
  )

const link = (url: string) => {
  const found = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url)
  if (found === null) return null
  const threadTs = /[?&]thread_ts=(\d+\.\d+)/.exec(url)?.[1]
  return { channel: found[1]!, ts: `${found[2]}.${found[3]}`, ...(threadTs === undefined || threadTs === `${found[2]}.${found[3]}` ? {} : { threadTs }) }
}

/** The proxy's `since` for a scan: the oldest cursor (`floor` at the latest), but no more than a week before `floor`. */
export const proxySince = (request: ScanRequest) => {
  const all = [...Object.values(request.cursor.conv), ...Object.values(request.cursor.threads), ...(request.cursor.mentions === undefined ? [] : [request.cursor.mentions])]
  const week = slackTs(Number(request.floor) * 1000 - 6 * 86_400_000)
  const oldest = all.reduce((min, ts) => (ts < min ? ts : min), request.floor)
  return isoOf(oldest < week ? week : oldest)
}

/**
 * The proxy's activity read as clusters, each message filtered by its own cursor: a mention by `mentions`, a thread reply
 * by its thread, a DM or group DM by its conversation, a channel post only in a `watch` channel. The proxy cannot list
 * whole threads, so a cluster's messages are the new ones it returned.
 */
export const clustersOf = (read: typeof ProxyRead.Type, request: ScanRequest): ReadonlyArray<Cluster> => {
  const groups = new Map<string, { via: Via; channel: string; items: Array<Activity & { readonly raw: string }>; advance: Array<Advance> }>()
  for (const item of read.items) {
    const at = link(item.url)
    if (at === null) continue
    const thread = at.threadTs === undefined ? undefined : `${at.channel}:${at.threadTs}`
    const [via, cursorKey, merge] = item.mentionsIsaac
      ? ["mention" as const, "mentions", thread ?? (item.kind === "channel" ? `${at.channel}:${at.ts}` : `${at.channel}:top`)]
      : thread !== undefined
      ? ["thread" as const, `thread:${thread}`, thread]
      : item.kind !== "channel"
      ? ["dm" as const, `conv:${at.channel}`, `${at.channel}:top`]
      : ["channel" as const, `conv:${at.channel}`, `${at.channel}:${at.ts}`]
    if (via === "channel" && !request.watch.includes(at.channel)) continue
    const cursor = cursorKey === "mentions"
      ? request.cursor.mentions
      : cursorKey.startsWith("thread:")
      ? request.cursor.threads[cursorKey.slice("thread:".length)]
      : request.cursor.conv[at.channel]
    if (at.ts <= (cursor ?? request.floor)) continue
    const group = groups.get(merge) ?? { via, channel: item.channel, items: [], advance: [] }
    if (via === "mention") group.via = "mention"
    group.items.push({ ...item, raw: at.ts })
    const same = group.advance.find((advance) => advance.key === cursorKey)
    if (same === undefined) group.advance.push({ key: cursorKey, from: at.ts, to: at.ts })
    else group.advance.splice(group.advance.indexOf(same), 1, { key: cursorKey, from: at.ts < same.from ? at.ts : same.from, to: at.ts > same.to ? at.ts : same.to })
    groups.set(merge, group)
  }
  return [...groups.entries()].map(([merge, group]) => {
    const items = [...group.items].sort((a, b) => (a.raw < b.raw ? -1 : 1))
    const op = [...items].reverse().find((item) => item.author !== read.authedUser)
    const at = op ?? items[items.length - 1]!
    return {
      key: merge.endsWith(":top") ? `${merge.slice(0, -4)}:${at.raw}` : merge,
      via: group.via,
      url: at.url,
      channel: group.channel,
      ts: isoOf(at.raw),
      emit: op !== undefined && !items.some((item) => item.author === read.authedUser && item.raw > op.raw),
      messages: items.map((item) => ({
        author: item.author,
        ts: isoOf(item.raw),
        text: item.text.slice(0, 400),
        ...(item.reactions.length === 0 ? {} : { reactions: item.reactions.map((reaction) => `:${reaction.emoji}: by ${reaction.byIsaac ? read.authedUser : `${reaction.count} people`}`) })
      })),
      advance: group.advance
    }
  })
}

/** `claude -p` with the claude.ai Slack connector. */
export const proxyReader = (claude: string, spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): Reader => {
  const read = proxyRead(claude, spawner)
  return {
    scan: (request) => read({ since: proxySince(request), urls: [] }).pipe(Effect.map((answer) => ({ authedUser: answer.authedUser, clusters: clustersOf(answer, request), failures: [] }))),
    threads: (urls) => read({ urls }).pipe(Effect.map((answer) => ({ authedUser: answer.authedUser, threads: answer.threads })))
  }
}

// ---------------------------------------------------------------------------------------------------------------

/** Slack reads from the desktop app, falling back to the proxy, read-only. */
export class Slack extends Context.Service<Slack, {
  /** What is new since the cursors. `choice` overrides the default (env `ECARD_SLACK_SOURCE`, else `auto`). */
  scan(request: ScanRequest, choice?: SourceChoice): Effect.Effect<Sourced<Scan>, SlackError>
  /** The conversations of `urls`. */
  threads(urls: ReadonlyArray<string>, choice?: SourceChoice): Effect.Effect<Sourced<Threads>, SlackError>
}>()("atomic-agents/ecard/Slack") {
  /** A Slack over two readers; `auto` tries `slack-desktop`, then `claude-proxy`. */
  static make(readers: Readonly<Record<Source, Reader>>, defaultChoice: SourceChoice = "auto") {
    const choose = <A>(choice: SourceChoice, read: (reader: Reader) => Effect.Effect<A, SlackError>): Effect.Effect<Sourced<A>, SlackError> => {
      const from = (source: Source) => read(readers[source]).pipe(Effect.map((answer): Sourced<A> => ({ ...answer, source })))
      return choice !== "auto"
        ? from(choice)
        : from("slack-desktop").pipe(
          Effect.catchTag("SlackError", (desktop) =>
            from("claude-proxy").pipe(
              Effect.map((answer): Sourced<A> => ({ ...answer, fallbackReason: desktop.message })),
              Effect.mapError((proxy) => new SlackError({ message: `${desktop.message}; then ${proxy.message}` }))
            ))
        )
    }
    return Slack.of({
      scan: (request, choice = defaultChoice) => choose(choice, (reader) => reader.scan(request)),
      threads: (urls, choice = defaultChoice) => choose(choice, (reader) => reader.threads(urls))
    })
  }

  static readonly layer = Layer.effect(
    Slack,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const path = yield* Path.Path
      const claude = process.env["CLAUDE_BIN"] ?? path.join(process.env["HOME"] ?? "", ".local", "bin", "claude")
      const choice = Schema.decodeUnknownOption(SourceChoice)(process.env["ECARD_SLACK_SOURCE"])
      return Slack.make(
        { "slack-desktop": desktopReader(process.env["SLACK_CDP_URL"] ?? "http://127.0.0.1:9333"), "claude-proxy": proxyReader(claude, spawner) },
        choice._tag === "Some" ? choice.value : "auto"
      )
    })
  )
}

/** The slack triage chef's surface (`work/elysia/slack-chef.md` under Eva's checkout); ecard-slack-digest is its only writer. */
export class ChefSurface extends Context.Service<ChefSurface, {
  readonly file: string
  /** Replaces the file whole (tmp + rename). */
  write(text: string): Effect.Effect<void, SlackError>
}>()("atomic-agents/ecard/ChefSurface") {
  static readonly layer = Layer.effect(
    ChefSurface,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = path.join(yield* EvaRoot, "work", "elysia", "slack-chef.md")
      return ChefSurface.of({
        file,
        write: (text) =>
          fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(`${file}.tmp`, text)),
            Effect.andThen(fs.rename(`${file}.tmp`, file)),
            Effect.mapError((error) => new SlackError({ message: `${file}: ${error.message}` }))
          )
      })
    })
  )
}
