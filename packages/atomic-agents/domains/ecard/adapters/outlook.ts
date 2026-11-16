import { Context, Effect, Layer, Path, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { exec } from "../../../src/core/exec.ts"

/**
 * eCard Outlook, read-only. There is no API token here; the background read path is the `claude -p` proxy with
 * the claude.ai Microsoft 365 connector (its tool list is the connector, every built-in is disallowed, the prompt
 * forbids changes). Outlook web in Arc over CDP (:9222) is the fallback a person drives
 * (references/tools/accounts-and-messaging.md).
 */

export const Email = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  received: Schema.String,
  /** Plain text, at most 3000 chars. */
  body: Schema.String,
  /** Earlier messages of the conversation, oldest first, not this one. */
  thread: Schema.Array(Schema.Struct({ from: Schema.String, at: Schema.String, body: Schema.String }))
})
export type Email = typeof Email.Type

export class OutlookError extends Schema.TaggedError<OutlookError>()("OutlookError", { message: Schema.String }) {}

/** Emails per fetch, oldest first; the rest wait for the next run. One proxy call covers them all. */
export const MAX_PER_RUN = 15

const decodeEmails = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Email)))

/** Inbox messages through the claude.ai Microsoft 365 connector, read-only. */
export class Outlook extends Context.Service<Outlook, {
  inbox(since: string): Effect.Effect<ReadonlyArray<Email>, OutlookError>
}>()("atomic-agents/ecard/Outlook") {
  static readonly layer = Layer.effect(
    Outlook,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const path = yield* Path.Path
      const claude = process.env["CLAUDE_BIN"] ?? path.join(process.env["HOME"] ?? "", ".local", "bin", "claude")
      return Outlook.of({
        inbox: (since) =>
          exec(claude, [
            "-p", [
              "READ-ONLY. Never send, reply, forward, move, flag, delete or mark anything read.",
              `List the messages in Isaac Weber's Outlook Inbox received after ${since}, oldest first, at most ${MAX_PER_RUN}.`,
              "For each, read the message body and its conversation (the earlier messages of the same thread, at most 3).",
              "Output ONLY a JSON array (no prose, no code fence), one object per message:",
              `{"id": "<message id>", "from": "Name <email>", "to": ["Name <email>"], "subject": "...", "received": "<ISO 8601 UTC>", "body": "<plain text, max 3000 chars>", "thread": [{"from": "Name <email>", "at": "<ISO>", "body": "<max 800 chars>"}]}.`,
              "An empty inbox window is []."
            ].join(" "),
            "--allowedTools", "mcp__claude_ai_Microsoft_365",
            "--permission-mode", "dontAsk",
            "--disallowedTools", "Bash Read Write Edit Glob Grep WebFetch WebSearch Task NotebookEdit"
          ]).pipe(
            Effect.timeoutOrElse({ duration: "15 minutes", orElse: () => Effect.fail(new OutlookError({ message: "claude proxy timed out" })) }),
            Effect.catchTag("PlatformError", (error) => Effect.fail(new OutlookError({ message: error.message }))),
            Effect.flatMap((result) => {
              const text = result.stdout
              const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)
              return result.exitCode !== 0 || json === ""
                ? Effect.fail(new OutlookError({ message: `claude proxy: ${(result.stderr || text).trim().slice(-300)}` }))
                : decodeEmails(json).pipe(Effect.mapError((error) => new OutlookError({ message: `claude proxy output: ${error.message}` })))
            }),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
          )
      })
    })
  )
}
