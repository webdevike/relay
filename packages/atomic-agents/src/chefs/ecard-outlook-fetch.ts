import { Clock, Effect, FileSystem, Path, Schema } from "effect"
import { Email, MAX_PER_RUN, Outlook } from "../adapters/ecard/outlook.ts"
import { type Component, define, job, Trigger } from "../Component.ts"

/**
 * `kind: "code"` chef (`chefs/ecard-outlook-fetch.json`): the fetch in front of ecard-outlook-triage. No model and
 * no per-item turn, so the recipe does not fit: one proxy call reads the inbox window, then one event per email.
 */

const events = {
  /** One per new inbox email: ecard-outlook-triage's input. */
  "email.fetched": Email,
  "fetch.completed": Schema.Struct({ since: Schema.String, fetched: Schema.Int })
}

export class CursorError extends Schema.TaggedError<CursorError>()("CursorError", { message: Schema.String }) {}

const Cursor = Schema.Struct({ received: Schema.String, ids: Schema.Array(Schema.String) })
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))

const fetch = job(events, {
  id: "fetch",
  description: "Fetch new eCard Outlook inbox emails with their thread (read-only, claude proxy) and hand each to ecard-outlook-triage.",
  input: Schema.Struct({}),
  triggers: [Trigger.Manual(), Trigger.Cron({ cron: "10,40 * * * *", input: Effect.succeed({}) })],
  run: Effect.fnUntraced(function*(_, ctx) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = path.join(ctx.stateDir, "cursor.json")
    const cursorError = (error: { readonly message: string }) => new CursorError({ message: `${file}: ${error.message}` })
    // No cursor: start 24 h back. The cursor keeps the ids at its timestamp so a same-second email is neither lost nor repeated.
    const cursor = (yield* fs.exists(file).pipe(Effect.mapError(cursorError)))
      ? yield* fs.readFileString(file).pipe(Effect.flatMap(decodeCursor), Effect.mapError(cursorError))
      : { received: new Date((yield* Clock.currentTimeMillis) - 24 * 3_600_000).toISOString(), ids: [] }
    const emails = (yield* (yield* Outlook).inbox(cursor.received))
      .filter((email) => email.received >= cursor.received && !cursor.ids.includes(email.id))
      .sort((a, b) => a.received.localeCompare(b.received))
      .slice(0, MAX_PER_RUN)
    let next = cursor
    for (const email of emails) {
      yield* ctx.emit("email.fetched", email)
      next = { received: email.received, ids: email.received === next.received ? [...next.ids, email.id] : [email.id] }
      yield* fs.writeFileString(`${file}.tmp`, `${JSON.stringify(next)}\n`).pipe(Effect.andThen(fs.rename(`${file}.tmp`, file)), Effect.mapError(cursorError))
    }
    yield* ctx.emit("fetch.completed", { since: cursor.received, fetched: emails.length })
  })
})

export const spec = {
  id: "ecard-outlook-fetch",
  events,
  purpose: "Fetch each new eCard Outlook inbox email with its thread, read-only, for ecard-outlook-triage.",
  agent: {
    // No model calls: the fetch is a fixed read. Kept for the Component shape.
    model: "anthropic/claude-haiku-5-5",
    candidates: ["anthropic/claude-haiku-5-5"],
    system: ""
  },
  jobs: [fetch],
  tools: Outlook.layer
} satisfies Component<Outlook>

export default define(spec)
