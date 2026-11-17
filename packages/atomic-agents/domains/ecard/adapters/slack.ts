import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { EvaRoot } from "../../../src/core/adapters/eva.ts"
import { exec } from "../../../src/core/exec.ts"

/**
 * Slack, read-only, for the eCard agents, from two sources with the same output:
 * - `claude-proxy` (default): `claude -p` with the claude.ai Slack connector (its tool list is the connector, every
 *   built-in is disallowed, the prompt forbids posting, reacting and marking read).
 * - `slack-desktop` (fallback): Isaac's signed-in Slack desktop app over CDP (:9333, launched with
 *   `--remote-debugging-port=9333 --user-data-dir=.../Slack-cdp`). One `Runtime.evaluate` in the client page calls
 *   read-only Web API methods (an allowlist) with the client's own session; it never opens a conversation, types,
 *   clicks or sends.
 * `auto` reads through the proxy and, when that fails (error, timeout, no authed Slack user, unreadable output), reads
 * the same request from the desktop app; the answer names the source it came from and why it fell back.
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
  /** Elysia's line for it (who, where, gist, why). */
  summary: Schema.String,
  /** The thread, or the message and the ones after it, in time order. */
  messages: Schema.Array(Message)
})
export type Item = typeof Item.Type

/** A permalink's conversation: the thread, else the linked message and the 8 after it, in time order (ISO `ts`). */
export const Thread = Schema.Struct({ url: Schema.String, channel: Schema.String, ts: Schema.String, messages: Schema.Array(Message) })
export type Thread = typeof Thread.Type

export const Reaction = Schema.Struct({ emoji: Schema.String, count: Schema.Int, byIsaac: Schema.Boolean })

/** One message posted after the cursor in a DM, group DM or channel of Isaac's, or one that @-mentions him anywhere. */
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

export const Source = Schema.Literals(["claude-proxy", "slack-desktop"])
export type Source = typeof Source.Type
/** `auto`: the proxy, then the desktop app when the proxy fails. A source by name: that one only. */
export const SourceChoice = Schema.Literals(["auto", "claude-proxy", "slack-desktop"])
export type SourceChoice = typeof SourceChoice.Type

/** What to read: activity after `since` (ISO), and the conversations of `urls` (permalinks). */
export interface ReadRequest {
  readonly since?: string
  readonly urls: ReadonlyArray<string>
}

export const Read = Schema.Struct({
  /** The Slack user the source is signed in as; empty means it never reached Slack. */
  authedUser: Schema.String,
  /** Newest first; empty when the request had no `since`. */
  items: Schema.Array(Activity),
  threads: Schema.Array(Thread)
})
export type Read = typeof Read.Type

export interface Sourced extends Read {
  readonly source: Source
  /** Why `auto` left the proxy for the desktop app. */
  readonly fallbackReason?: string
}

export class SlackError extends Schema.TaggedError<SlackError>()("SlackError", { message: Schema.String }) {}

/** One way to read Slack. */
export type Reader = (request: ReadRequest) => Effect.Effect<Read, SlackError>

/** Activity items per read, newest first; DMs and mentions of Isaac are kept before channel chatter. */
export const MAX_ITEMS = 150
const TEAM = "T0LS0H1CG"

const PERMALINK = /https:\/\/[\w-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+(?:\?[^\s)]*)?/

/** `## Needs your attention` bullets of Elysia's `work/elysia/slack.md` that carry a permalink. */
export const flaggedItems = (markdown: string): ReadonlyArray<{ readonly url: string; readonly summary: string }> => {
  const section = markdown.split(/^## Needs your attention\s*$/m)[1]?.split(/^## /m)[0] ?? ""
  return section.split("\n").flatMap((line) => {
    const url = PERMALINK.exec(line)?.[0]
    return line.startsWith("- ") && url !== undefined ? [{ url, summary: line.slice(2).replace(/\s*\[permalink\]\([^)]*\)/, "").trim().slice(0, 400) }] : []
  })
}

const decodeRead = Schema.decodeUnknownEffect(Read)
const checked = (source: Source, value: unknown) =>
  decodeRead(value).pipe(
    Effect.mapError((error) => new SlackError({ message: `${source} output: ${error.message}` })),
    Effect.filterOrFail((read) => read.authedUser.trim() !== "", () => new SlackError({ message: `${source}: no authed Slack user (not signed in?)` }))
  )

const proxyPrompt = (request: ReadRequest) =>
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

/** `claude -p` with the claude.ai Slack connector. */
const proxyReader = (claude: string, spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]): Reader => (request) =>
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
            : checked("claude-proxy", value)
        )
      )
    }),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
  )

/** The Web API methods the desktop reader may call: reads only. */
const READ_METHODS = ["auth.test", "users.conversations", "users.info", "conversations.info", "conversations.members", "conversations.history", "conversations.replies", "search.messages", "reactions.get"]

interface SlackMessage {
  readonly ts: string
  readonly user?: string
  readonly username?: string
  readonly bot_profile?: { readonly name?: string }
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
}
interface SearchMatch extends SlackMessage {
  readonly channel: SlackConversation
  readonly permalink: string
  readonly no_reactions?: boolean
}

/**
 * Runs INSIDE the Slack client page (serialized with `toString`, so it may use only browser globals and its argument):
 * read-only Web API calls with the signed-in client's session, through `READ_METHODS` only.
 */
const inSlackPage = async (args: { team: string; since?: string; urls: ReadonlyArray<string>; max: number; methods: ReadonlyArray<string> }) => {
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
    // The read methods' documented shapes; `checked` validates the whole answer once it leaves the page.
    return json as A
  }
  const iso = (ts: string) => new Date(Number(ts) * 1000).toISOString()
  const me = await api<{ user_id: string }>("auth.test")
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
  const authedUser = await name(me.user_id, me.user_id)
  const readable = async (message: SlackMessage, max: number) => {
    let text = message.text || message.attachments?.map((attachment) => attachment.fallback ?? "").join(" ") || ""
    for (const id of new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((match) => match[1]!))) text = text.replaceAll(`<@${id}>`, `@${await name(id, id)}`)
    return text.replace(/<#[A-Z0-9]+\|([^>]*)>/g, "#$1").replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)").replace(/<(https?:[^>]+)>/g, "$1").slice(0, max)
  }
  const labels = new Map<string, Promise<{ label: string; kind: "dm" | "group_dm" | "channel" }>>()
  const conversation = (id: string, known?: SlackConversation) => {
    let found = labels.get(id)
    if (found === undefined) {
      found = (async () => {
        const conv = known?.is_im !== undefined ? known : (await api<{ channel: SlackConversation }>("conversations.info", { channel: id })).channel
        if (conv.is_im) return { label: `DM with ${await name(conv.user, conv.user ?? "someone")}`, kind: "dm" as const }
        if (conv.is_mpim) {
          const { members } = await api<{ members: ReadonlyArray<string> }>("conversations.members", { channel: id, limit: 50 })
          const others = await Promise.all(members.filter((member) => member !== me.user_id).map((member) => name(member, member)))
          return { label: `group DM: ${others.join(", ")}`, kind: "group_dm" as const }
        }
        return { label: `#${conv.name ?? id}`, kind: "channel" as const }
      })()
      labels.set(id, found)
    }
    return found
  }

  const items = []
  if (args.since !== undefined) {
    const since = Date.parse(args.since) / 1000
    if (!Number.isFinite(since)) throw new Error(`since is not a time: ${args.since}`)
    const mine = new Map<string, SlackConversation>()
    let cursor = ""
    do {
      const page = await api<{ channels: ReadonlyArray<SlackConversation>; response_metadata?: { next_cursor?: string } }>("users.conversations", {
        types: "public_channel,private_channel,mpim,im",
        exclude_archived: true,
        limit: 1000,
        ...(cursor === "" ? {} : { cursor })
      })
      for (const conv of page.channels) mine.set(conv.id, conv)
      cursor = page.response_metadata?.next_cursor ?? ""
    } while (cursor !== "")
    // Search covers every conversation; Slack's `after:` is by day, so start a day early and cut at `since`.
    const day = new Date((since - 86_400) * 1000).toISOString().slice(0, 10)
    const found: Array<SearchMatch> = []
    for (let page = 1; page <= 10; page++) {
      const result = await api<{ messages?: { matches?: ReadonlyArray<SearchMatch>; paging?: { pages?: number } } }>("search.messages", {
        query: `after:${day}`,
        sort: "timestamp",
        sort_dir: "desc",
        count: 100,
        page
      })
      const matches = result.messages?.matches ?? []
      found.push(...matches.filter((match) => Number(match.ts) > since))
      if (matches.length === 0 || Number(matches[matches.length - 1]!.ts) <= since || page >= (result.messages?.paging?.pages ?? 1)) break
    }
    const mention = `<@${me.user_id}>`
    const seen = new Set<string>()
    const direct = (match: SearchMatch) => match.channel.is_im === true || match.channel.is_mpim === true || (match.text ?? "").includes(mention)
    const kept = found
      .filter((match) => {
        const key = `${match.channel.id}/${match.ts}`
        if (seen.has(key) || !(mine.has(match.channel.id) || (match.text ?? "").includes(mention))) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => Number(direct(b)) - Number(direct(a)) || Number(b.ts) - Number(a.ts))
      .slice(0, args.max)
      .sort((a, b) => Number(b.ts) - Number(a.ts))
    for (const match of kept) {
      const where = await conversation(match.channel.id, mine.get(match.channel.id) ?? match.channel)
      const threadTs = new URL(match.permalink).searchParams.get("thread_ts")
      const reactions = match.no_reactions === true
        ? []
        : ((await api<{ message?: SlackMessage }>("reactions.get", { channel: match.channel.id, timestamp: match.ts, full: true })).message?.reactions ?? [])
      items.push({
        url: match.permalink,
        channel: where.label,
        kind: where.kind,
        author: await name(match.user, match.username ?? match.bot_profile?.name ?? "unknown"),
        ts: iso(match.ts),
        text: await readable(match, 600),
        ...(threadTs !== null && threadTs !== match.ts ? { threadTs: iso(threadTs) } : {}),
        mentionsIsaac: (match.text ?? "").includes(mention),
        reactions: reactions.map((reaction) => ({ emoji: reaction.name, count: reaction.count, byIsaac: reaction.users?.includes(me.user_id) ?? false }))
      })
    }
  }

  const threads = []
  for (const url of args.urls) {
    const link = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url)
    if (link === null) continue
    const channel = link[1]!
    const ts = `${link[2]}.${link[3]}`
    const threadTs = new URL(url).searchParams.get("thread_ts")
    let messages: ReadonlyArray<SlackMessage>
    if (threadTs !== null) {
      messages = (await api<{ messages: ReadonlyArray<SlackMessage> }>("conversations.replies", { channel, ts: threadTs, limit: 100 })).messages
    } else {
      // `oldest` alone returns the messages nearest it, newest first: the linked one and the 8 after it.
      const after = [...(await api<{ messages: ReadonlyArray<SlackMessage> }>("conversations.history", { channel, oldest: ts, inclusive: true, limit: 9 })).messages].reverse()
      messages = (after[0]?.reply_count ?? 0) > 0
        ? (await api<{ messages: ReadonlyArray<SlackMessage> }>("conversations.replies", { channel, ts, limit: 100 })).messages
        : after
    }
    const shown = []
    for (const message of messages) {
      const reactions = []
      for (const reaction of message.reactions ?? []) {
        reactions.push(`:${reaction.name}: by ${(await Promise.all((reaction.users ?? []).map((user) => name(user, user)))).join(", ")}`)
      }
      shown.push({ author: await name(message.user, message.username ?? message.bot_profile?.name ?? "unknown"), ts: iso(message.ts), text: await readable(message, 400), ...(reactions.length === 0 ? {} : { reactions }) })
    }
    threads.push({ url, channel: (await conversation(channel)).label, ts: iso(ts), messages: shown })
  }
  return { authedUser, items, threads }
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

/** Slack desktop over CDP: evaluates `inSlackPage` in the `app.slack.com/client` page and returns its value. */
const desktopReader = (cdp: string): Reader => (request) =>
  Effect.tryPromise({
    try: async (signal) => {
      const targets = decodeTargets(await (await fetch(`${cdp}/json/list`, { signal })).json())
      const page = targets.find((target) => target.type === "page" && target.url.includes("app.slack.com/client"))
      if (page?.webSocketDebuggerUrl === undefined) throw new Error(`no app.slack.com/client page on ${cdp}`)
      const args = { team: TEAM, ...(request.since === undefined ? {} : { since: request.since }), urls: request.urls, max: MAX_ITEMS, methods: READ_METHODS }
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
  }).pipe(
    Effect.timeoutOrElse({ duration: "4 minutes", orElse: () => Effect.fail(new SlackError({ message: "slack desktop timed out after 4 minutes" })) }),
    Effect.flatMap((value) => checked("slack-desktop", value))
  )

/** Slack reads from the proxy, falling back to the desktop app, read-only. */
export class Slack extends Context.Service<Slack, {
  /** `choice` overrides the default (env `ECARD_SLACK_SOURCE`, else `auto`). */
  read(request: ReadRequest, choice?: SourceChoice): Effect.Effect<Sourced, SlackError>
}>()("atomic-agents/ecard/Slack") {
  /** A Slack over two readers; `auto` tries `claude-proxy`, then `slack-desktop`. */
  static make(readers: Readonly<Record<Source, Reader>>, defaultChoice: SourceChoice = "auto") {
    const from = (source: Source, request: ReadRequest) => readers[source](request).pipe(Effect.map((read): Sourced => ({ ...read, source })))
    return Slack.of({
      read: (request, choice = defaultChoice) =>
        choice !== "auto"
          ? from(choice, request)
          : from("claude-proxy", request).pipe(
            Effect.catchTag("SlackError", (proxy) =>
              from("slack-desktop", request).pipe(
                Effect.map((read): Sourced => ({ ...read, fallbackReason: proxy.message })),
                Effect.mapError((desktop) => new SlackError({ message: `${proxy.message}; then ${desktop.message}` }))
              ))
          )
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
        { "claude-proxy": proxyReader(claude, spawner), "slack-desktop": desktopReader(process.env["SLACK_CDP_URL"] ?? "http://127.0.0.1:9333") },
        choice._tag === "Some" ? choice.value : "auto"
      )
    })
  )
}

/** Elysia's Slack surface (`work/elysia/slack.md` under Eva's checkout), read each run. */
export class Flags extends Context.Service<Flags, {
  readonly read: Effect.Effect<string, SlackError>
}>()("atomic-agents/ecard/Flags") {
  static readonly layer = Layer.effect(
    Flags,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const file = path.join(yield* EvaRoot, "work", "elysia", "slack.md")
      return Flags.of({ read: fs.readFileString(file).pipe(Effect.mapError((error) => new SlackError({ message: `${file}: ${error.message}` }))) })
    })
  )
}
