import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { EvaRoot } from "../eva.ts"
import { exec } from "../../exec.ts"

/**
 * Slack, read-only, for the eCard chefs. There is no Slack token here; the only background read path is the
 * `claude -p` proxy with the claude.ai Slack connector (its tool list is the connector, every built-in is
 * disallowed, the prompt forbids posting). The Slack desktop app over CDP (:9333) is the fallback a person
 * drives, not a chef.
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

export class SlackError extends Schema.TaggedError<SlackError>()("SlackError", { message: Schema.String }) {}

const PERMALINK = /https:\/\/[\w-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+(?:\?[^\s)]*)?/

/** `## Needs your attention` bullets of Elysia's `work/elysia/slack.md` that carry a permalink. */
export const flaggedItems = (markdown: string): ReadonlyArray<{ readonly url: string; readonly summary: string }> => {
  const section = markdown.split(/^## Needs your attention\s*$/m)[1]?.split(/^## /m)[0] ?? ""
  return section.split("\n").flatMap((line) => {
    const url = PERMALINK.exec(line)?.[0]
    return line.startsWith("- ") && url !== undefined ? [{ url, summary: line.slice(2).replace(/\s*\[permalink\]\([^)]*\)/, "").trim().slice(0, 400) }] : []
  })
}

const PROMPT = [
  "READ-ONLY. Never post, reply or react. For each Slack permalink below: if it is in a thread, read the whole thread; otherwise read that message plus the 8 messages after it in the same conversation.",
  "Output ONLY a JSON array (no prose, no code fence), one object per permalink: {\"url\": \"<permalink as given>\", \"channel\": \"<#name, or DM/group DM with names>\", \"ts\": \"<the linked message ts>\", \"messages\": [{\"author\": \"<display name>\", \"ts\": \"<ts>\", \"text\": \"<max 400 chars>\", \"reactions\": [\"<emoji> by <names>\"]}]}.",
  "messages includes the linked message itself and is in time order. Isaac Weber is the authed user. Permalinks:"
].join(" ")

const Fetched = Schema.Array(Schema.Struct({ url: Schema.String, channel: Schema.String, ts: Schema.String, messages: Schema.Array(Message) }))
const decodeFetched = Schema.decodeUnknownEffect(Schema.fromJsonString(Fetched))

/** Slack threads by permalink through the claude.ai connector, read-only. */
export class Slack extends Context.Service<Slack, {
  threads(urls: ReadonlyArray<string>): Effect.Effect<typeof Fetched.Type, SlackError>
}>()("atomic-agents/ecard/Slack") {
  static readonly layer = Layer.effect(
    Slack,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const path = yield* Path.Path
      const claude = process.env["CLAUDE_BIN"] ?? path.join(process.env["HOME"] ?? "", ".local", "bin", "claude")
      return Slack.of({
        threads: (urls) =>
          exec(claude, [
            "-p", `${PROMPT}\n${urls.join("\n")}`,
            "--allowedTools", "mcp__claude_ai_Slack",
            "--permission-mode", "dontAsk",
            "--disallowedTools", "Bash Read Write Edit Glob Grep WebFetch WebSearch Task NotebookEdit"
          ]).pipe(
            Effect.timeoutOrElse({ duration: "15 minutes", orElse: () => Effect.fail(new SlackError({ message: "claude proxy timed out" })) }),
            Effect.catchTag("PlatformError", (error) => Effect.fail(new SlackError({ message: error.message }))),
            Effect.flatMap((result) => {
              const text = result.stdout
              const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)
              return result.exitCode !== 0 || json === ""
                ? Effect.fail(new SlackError({ message: `claude proxy: ${(result.stderr || text).trim().slice(-300)}` }))
                : decodeFetched(json).pipe(Effect.mapError((error) => new SlackError({ message: `claude proxy output: ${error.message}` })))
            }),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
          )
      })
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
