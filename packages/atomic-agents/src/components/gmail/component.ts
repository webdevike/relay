import { Config, Context, Effect, FileSystem, Layer, Path, PlatformError, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { type Component, define, job, moduleFile, Trigger } from "../../Component.ts"
import { exec } from "../../exec.ts"
import { generateWithTools, tool } from "../../Model.ts"

export const Verdict = Schema.Literals(["needs_isaac", "fyi", "noise"])

/** Output contract. Shadow mode: nothing routes these yet; they sit beside the heartbeat's Gmail source for comparison. */
const events = {
  /** One per message. `id` is the RFC 822 Message-ID, the same id the heartbeat's Gmail source uses. */
  "message.triaged": Schema.Struct({
    id: Schema.String,
    from: Schema.String,
    subject: Schema.String,
    /** ISO UTC. */
    date: Schema.String,
    verdict: Verdict,
    /** One line: why it needs Isaac, or why not. */
    reason: Schema.String,
    /** Short card title, verb first when it needs him. */
    title: Schema.String
  }),
  /** Once per run: what it cost. `replay` runs (explicit ids, as in a bench) leave the cursor alone. */
  "triage.completed": Schema.Struct({
    messages: Schema.Int,
    modelCalls: Schema.Int,
    cost: Schema.Number,
    replay: Schema.Boolean
  })
}

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

/** Where the last run stopped, in `<home>/state/gmail/cursor.json`. A new UIDVALIDITY starts over from the last 24 hours. */
export const Cursor = Schema.Struct({ validity: Schema.Int, uid: Schema.Int })
export type Cursor = typeof Cursor.Type

const decodeBatch = Schema.decodeUnknownEffect(Schema.fromJsonString(Batch))
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor))

/**
 * Tool: Isaac's personal Gmail, read-only. Wraps `mail.py`, which reuses the heartbeat's IMAP login
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

/** Eva's checkout: the heartbeat's Gmail login and Nova's Catch Up taste live there. */
const EvaRoot = Effect.gen(function*() {
  const path = yield* Path.Path
  const home = yield* Config.String("HOME")
  return yield* Config.String("EVA_ROOT").pipe(Config.withDefault(path.join(home, "Eva")))
})

/**
 * Knowledge: Nova's Catch Up taste (`catchup-taste.md`) and its machine rules (`catchup-rules.json`),
 * read at the start of every run, so Nova's edits apply to the next run without a restart.
 */
export class Taste extends Context.Service<Taste, {
  readonly load: Effect.Effect<string, PlatformError.PlatformError>
}>()("atomic-agents/gmail/Taste") {
  static readonly layer = Layer.effect(
    Taste,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const nova = path.join(yield* EvaRoot, "work", "eva", "agents", "nova")
      return Taste.of({
        load: Effect.gen(function*() {
          const taste = yield* fs.readFileString(path.join(nova, "catchup-taste.md"))
          const rules = yield* fs.readFileString(path.join(nova, "catchup-rules.json"))
          return `${taste.trim()}\n\n## catchup-rules.json (the same taste as rules Catch Up applies)\n${rules.trim()}`
        })
      })
    })
  )
}

/** Messages per run; the rest wait for the next run (the cursor stops at the last one triaged). */
export const MAX_PER_RUN = 40
/** Model calls per message, the answer included: up to two tool calls, then it must answer. */
export const MAX_STEPS = 3

const Answer = Schema.Struct({ verdict: Verdict, reason: Schema.NonEmptyString, title: Schema.NonEmptyString })

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

const triage = job(events, {
  id: "triage",
  description: "Triage personal Gmail that arrived since the last run (or the given Message-IDs, cursor untouched): needs_isaac | fyi | noise per message.",
  input: Schema.Struct({ ids: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)) }),
  triggers: [Trigger.Manual(), Trigger.Cron({ cron: "*/30 * * * *", input: Effect.succeed({}) })],
  run: Effect.fnUntraced(function*({ ids }, ctx) {
    const gmail = yield* Gmail
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const system = `${ctx.agent.system}\n\n## Isaac's taste (Nova's notes from his Catch Up cards)\n${yield* (yield* Taste).load}`
    const file = path.join(ctx.stateDir, "cursor.json")
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
    const tools = [
      tool({
        name: "read_thread",
        description: "The conversation this message belongs to: how many messages, and the last few (sender, date, whether Isaac sent it, text excerpt).",
        args: Schema.Struct({ id: Schema.NonEmptyString }),
        example: `{"id": "<message id>"}`,
        run: ({ id }) => gmail.readThread(id)
      }),
      tool({
        name: "sender_history",
        description: "How often this address has written to Isaac (all time, last 90 days), how often he wrote to it, how many he starred, its recent subjects.",
        args: Schema.Struct({ address: Schema.NonEmptyString }),
        example: `{"address": "<email address>"}`,
        run: ({ address }) => gmail.senderHistory(address)
      })
    ]
    let cost = 0
    let modelCalls = 0
    // Oldest first, the cursor moving past each message once its event is in the journal: a failure resumes there.
    for (const message of batch.messages) {
      const result = yield* generateWithTools({
        model: ctx.model,
        system,
        prompt: describe(message),
        ...(ctx.agent.thinking ? { thinking: ctx.agent.thinking } : {})
      }, {
        tools,
        answer: Answer,
        answerExample: `{"verdict": "needs_isaac" | "fyi" | "noise", "reason": "<one line>", "title": "<short card title>"}`,
        maxSteps: MAX_STEPS
      })
      cost += result.cost
      modelCalls += result.steps
      yield* ctx.emit("message.triaged", {
        id: message.id,
        from: message.from,
        subject: message.subject,
        date: message.date,
        ...result.answer
      })
      if (!replay) yield* save({ validity: batch.validity, uid: message.uid })
    }
    if (!replay) yield* save({ validity: batch.validity, uid: batch.through })
    yield* ctx.emit("triage.completed", { messages: batch.messages.length, modelCalls, cost, replay })
  })
})

/** The component without its tools, so tests can provide fakes for Gmail and Taste. */
export const spec = {
  id: "gmail" as const,
  events,
  purpose: "Sort Isaac's new personal Gmail into needs_isaac, fyi or noise, with a one-line reason and a card title.",
  agent: {
    model: "anthropic/claude-haiku-5-5",
    candidates: ["anthropic/claude-haiku-5-5", "openai-codex/gpt-6-luna", "anthropic/claude-sonnet-5-5"],
    thinking: "off",
    system: [
      "You triage Isaac's personal Gmail (his eCard work mail is elsewhere), one message at a time.",
      "needs_isaac: he has to decide, reply, pay, sign or act himself, and there is a real next step now.",
      "fyi: worth him knowing (a receipt, a confirmation, a status he cares about), nothing to do.",
      "noise: marketing, newsletters, social and automated notices he would not miss.",
      "reason: one line, under 15 words, why it needs him or why not. title: under 60 characters; for needs_isaac, verb first (\"Reply to Dana about Saturday\")."
    ].join("\n")
  },
  jobs: [triage],
  tools: Layer.mergeAll(Gmail.layer, Taste.layer)
} satisfies Component<Gmail | Taste>

export const gmail = define(spec)
