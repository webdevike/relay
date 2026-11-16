import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { ChildProcessSpawner } from "effect/process"
import { pack, toolAdapter } from "../../../src/core/Adapter.ts"
import { moduleFile, type ToolsError } from "../../../src/core/Component.ts"
import { exec } from "../../../src/core/exec.ts"
import { EvaRoot } from "../../../src/core/adapters/eva.ts"

export class GmailError extends Schema.TaggedError<GmailError>()("GmailError", {
  message: Schema.String
}) {}

export class CursorError extends Schema.TaggedError<CursorError>()("CursorError", {
  message: Schema.String
}) {}

export const Message = Schema.Struct({
  /** IMAP UID in "[Gmail]/All Mail"; only meaningful with the batch's `validity`. */
  uid: Schema.Int,
  id: Schema.String,
  from: Schema.String,
  address: Schema.String,
  to: Schema.String,
  subject: Schema.String,
  date: Schema.String,
  labels: Schema.Array(Schema.String),
  /** Carries a List-Unsubscribe header. */
  bulk: Schema.Boolean,
  /** Plain text, quoted history dropped, first 1500 characters. */
  body: Schema.String
})
export type Message = typeof Message.Type

export const Batch = Schema.Struct({
  validity: Schema.Int,
  /** Every UID up to here has been examined: the cursor's next value once all `messages` are triaged. */
  through: Schema.Int,
  messages: Schema.Array(Message)
})
export type Batch = typeof Batch.Type

/** Where the last run stopped, in `<home>/state/<agent>/cursor.json`. A new UIDVALIDITY starts over from the last 24 hours. */
export const Cursor = Schema.Struct({ validity: Schema.Int, uid: Schema.Int })
export type Cursor = typeof Cursor.Type

const decodeBatch = Schema.decodeUnknownEffect(Schema.fromJsonString(Batch))
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))

/**
 * Isaac's personal Gmail, read-only. Wraps `mail.py`, which reuses the heartbeat's IMAP login
 * (`jobs/eva-heartbeat/scripts/gmail.py`, `secrets/gmail.env`) under `EVA_ROOT` and examines
 * All Mail read-only; there is no write operation to call.
 */
export class Gmail extends Context.Service<Gmail, {
  /** Inbound mail after `cursor` (else from the last 24 hours), oldest first, at most `limit`. */
  since(cursor: Cursor | undefined, limit: number): Effect.Effect<Batch, GmailError>
  /** These Message-IDs (a bench replay); `through` is 0. */
  byId(ids: ReadonlyArray<string>): Effect.Effect<Batch, GmailError>
  readThread(id: string): Effect.Effect<unknown, GmailError>
  senderHistory(address: string): Effect.Effect<unknown, GmailError>
}>()("atomic-agents/gmail/Gmail") {
  static readonly layer = Layer.effect(
    Gmail,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const evaRoot = yield* EvaRoot
      const script = yield* moduleFile(import.meta.url, "./mail.py")
      const mail = (args: ReadonlyArray<string>) =>
        exec("python3", [script, ...args], { env: { EVA_ROOT: evaRoot } }).pipe(
          Effect.timeoutOrElse({ duration: "2 minutes", orElse: () => Effect.fail(new GmailError({ message: `mail.py ${args[0]} timed out` })) }),
          Effect.catchTag("PlatformError", (error) => Effect.fail(new GmailError({ message: error.message }))),
          // mail.py prints {"error": "..."} and exits 2; never credentials.
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result.stdout)
              : Effect.fail(new GmailError({ message: `mail.py ${args[0]}: ${(result.stdout || result.stderr).trim().slice(-300)}` }))),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
        )
      const batch = (args: ReadonlyArray<string>) =>
        mail(args).pipe(Effect.flatMap((stdout) =>
          decodeBatch(stdout).pipe(Effect.mapError((error) => new GmailError({ message: `mail.py ${args[0]} output: ${error.message}` })))))
      const json = (args: ReadonlyArray<string>) =>
        mail(args).pipe(Effect.flatMap((stdout) =>
          Effect.try({ try: (): unknown => JSON.parse(stdout), catch: () => new GmailError({ message: `mail.py ${args[0]} printed no JSON` }) })))
      return Gmail.of({
        since: (cursor, limit) =>
          batch(["new", "--limit", String(limit), ...(cursor === undefined ? [] : ["--validity", String(cursor.validity), "--after", String(cursor.uid)])]),
        byId: (ids) => batch(["ids", ...ids]),
        readThread: (id) => json(["thread", id]),
        senderHistory: (address) => json(["sender", address])
      })
    })
  )
}

/** Messages per run; the rest wait for the next run (the cursor stops at the last one triaged). */
export const MAX_PER_RUN = 40

const describe = (message: Message) =>
  [
    `Message id: ${message.id}`,
    `From: ${message.from} <${message.address}>`,
    `To: ${message.to}`,
    `Date: ${message.date}`,
    `Subject: ${message.subject}`,
    `Gmail labels: ${message.labels.join(", ") || "none"}`,
    `Bulk mail (List-Unsubscribe header): ${message.bulk ? "yes" : "no"}`,
    "Body (start):",
    message.body || "(empty)"
  ].join("\n")

const decodeInput = Schema.decodeUnknownEffect(Schema.Struct({ ids: Schema.optionalKey(Schema.Array(Schema.String)) }))

/** What `mail.py thread` and `mail.py sender` print (`returns` of the two tools; mail.py prints `{error}` for an unknown id or address). */
const Refused = Schema.Struct({ error: Schema.String })
const Thread = Schema.Union([
  Schema.Struct({
    messages_in_thread: Schema.Int,
    shown: Schema.Array(Schema.Struct({ from: Schema.String, address: Schema.String, date: Schema.String, subject: Schema.String, sent_by_isaac: Schema.Boolean, text: Schema.String }))
  }),
  Refused
])
const SenderHistory = Schema.Union([
  Schema.Struct({
    address: Schema.String,
    messages_from: Schema.Int,
    from_last_90_days: Schema.Int,
    isaac_wrote_to_them: Schema.Int,
    starred_from: Schema.Int,
    recent: Schema.Array(Schema.Struct({ date: Schema.String, subject: Schema.String }))
  }),
  Refused
])

/** The gmail adapters over `layer` (the real `mail.py` wrapper, or a test fake). */
export const gmailPack = (layer: Layer.Layer<Gmail, ToolsError, BunServices> = Gmail.layer) =>
  pack({
    name: "gmail",
    layer,
    sources: [{
      name: "gmail.new_since_cursor",
      description:
        "Inbound personal Gmail after the cursor in <state>/cursor.json (none or a new UIDVALIDITY: the last 24 h), oldest first, at most 40 per run; the cursor moves past each message once its event is written. Input ids: replay those Message-IDs, cursor untouched.",
      provides: ["id", "from", "address", "to", "subject", "date", "labels", "bulk", "body", "message"],
      summary: ["messages", "replay"],
      fetch: (input, run) =>
        Effect.gen(function*() {
          const gmail = yield* Gmail
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { ids } = yield* decodeInput(input).pipe(Effect.mapError((error) => new GmailError({ message: `input: ${error.message}` })))
          const file = path.join(run.stateDir, "cursor.json")
          const cursorError = (error: { readonly message: string }) => new CursorError({ message: `${file}: ${error.message}` })
          const save = (cursor: Cursor) =>
            fs.writeFileString(`${file}.tmp`, `${JSON.stringify(cursor)}\n`).pipe(
              Effect.andThen(fs.rename(`${file}.tmp`, file)),
              Effect.mapError(cursorError)
            )
          const replay = ids !== undefined
          const cursor = replay || !(yield* fs.exists(file).pipe(Effect.mapError(cursorError)))
            ? undefined
            : yield* fs.readFileString(file).pipe(Effect.flatMap(decodeCursor), Effect.mapError(cursorError))
          const batch = replay ? yield* gmail.byId(ids) : yield* gmail.since(cursor, MAX_PER_RUN)
          return {
            items: batch.messages.map((message) => ({
              fields: { ...message, message: describe(message) },
              commit: replay ? Effect.void : save({ validity: batch.validity, uid: message.uid })
            })),
            done: replay ? Effect.void : save({ validity: batch.validity, uid: batch.through }),
            summary: { messages: batch.messages.length, replay }
          }
        })
    }],
    tools: [
      toolAdapter({
        name: "gmail.read_thread",
        description: "The conversation this message belongs to: how many messages, and the last few (sender, date, whether Isaac sent it, text excerpt).",
        args: Schema.Struct({ id: Schema.NonEmptyString }),
        example: `{"id": "<message id>"}`,
        returns: Thread,
        run: ({ id }) => Effect.gen(function*() { return yield* (yield* Gmail).readThread(id) })
      }),
      toolAdapter({
        name: "gmail.sender_history",
        description: "How often this address has written to Isaac (all time, last 90 days), how often he wrote to it, how many he starred, its recent subjects.",
        args: Schema.Struct({ address: Schema.NonEmptyString }),
        example: `{"address": "<email address>"}`,
        returns: SenderHistory,
        run: ({ address }) => Effect.gen(function*() { return yield* (yield* Gmail).senderHistory(address) })
      })
    ]
  })
