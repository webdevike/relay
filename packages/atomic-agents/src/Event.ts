import { Config, Context, DateTime, Effect, FileSystem, Layer, Option, Path, PubSub, Schedule, Schema, Stream } from "effect"

/**
 * The one envelope every component event travels in. `type` is `<component>/<name>`;
 * `data` was validated against the component's declared schema before it was written.
 * Runtime events (`<component>/job.started|job.succeeded|job.failed`) use the same shape.
 */
export class AgentEvent extends Schema.Class<AgentEvent>("atomic-agents/AgentEvent")({
  id: Schema.String,
  type: Schema.String,
  component: Schema.String,
  job: Schema.String,
  run: Schema.String,
  at: Schema.String,
  data: Schema.Unknown
}) {}

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEvent))

export class JournalError extends Schema.TaggedError<JournalError>()("JournalError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

/** Where events, runs and artifacts live: Relay's data dir (`~/.config/relay/atomic-agents`) unless overridden. */
export class Home extends Context.Service<Home, {
  readonly root: string
  readonly journal: string
  runDir(component: string, run: string): string
}>()("atomic-agents/Home") {
  static readonly layer = Layer.effect(
    Home,
    Effect.gen(function*() {
      const path = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const home = yield* Config.String("HOME")
      const root = yield* Config.String("ATOMIC_AGENTS_HOME").pipe(
        Config.withDefault(path.join(home, ".config", "relay", "atomic-agents"))
      )
      yield* fs.makeDirectory(root, { recursive: true })
      return Home.of({
        root,
        journal: path.join(root, "events.ndjson"),
        runDir: (component, run) => path.join(root, "runs", component, run)
      })
    })
  )
}

/**
 * The event bus. The append-only journal (`events.ndjson`) is the single source of truth and
 * the cross-process contract: any process (a Relay host, an assistant, `atomic-agents emit`)
 * appends lines; every bus tails the file and fans new lines out through a PubSub.
 */
export class EventBus extends Context.Service<EventBus, {
  publish(event: AgentEvent): Effect.Effect<void, JournalError>
  /** Events appended after this subscription opened; use `history` for the past. */
  readonly subscribe: Stream.Stream<AgentEvent>
  /** The whole journal, oldest first. */
  readonly history: Effect.Effect<ReadonlyArray<AgentEvent>, JournalError>
}>()("atomic-agents/EventBus") {
  static readonly layer = Layer.effect(
    EventBus,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const { journal } = yield* Home
      const pubsub = yield* PubSub.bounded<AgentEvent>(1024)
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub))

      const fail = (message: string) => (cause: unknown) => new JournalError({ message, cause })

      const size = fs.exists(journal).pipe(
        Effect.flatMap((exists) => exists ? fs.stat(journal).pipe(Effect.map((info) => info.size)) : Effect.succeed(0n)),
        Effect.mapError(fail("stat journal"))
      )

      const parse = (text: string) =>
        Effect.forEach(
          text.split("\n").filter((line) => line.trim() !== ""),
          (line) => decodeLine(line).pipe(Effect.option)
        ).pipe(Effect.map((events) => events.flatMap((event) => Option.isSome(event) ? [event.value] : [])))

      // Tail from the current end: a new bus never replays old history as live events.
      let offset: bigint = yield* size
      const poll = Effect.gen(function*() {
        const end = yield* size
        if (end < offset) offset = 0n // journal was rotated
        if (end === offset) return
        const chunk = yield* Effect.scoped(Effect.gen(function*() {
          const file = yield* fs.open(journal, { flag: "r" })
          return yield* file.readAlloc(Number(end - offset), { position: offset })
        })).pipe(Effect.mapError(fail("read journal")))
        if (Option.isNone(chunk)) return
        const text = new TextDecoder().decode(chunk.value)
        const complete = text.lastIndexOf("\n") + 1 // a writer may be mid-line
        offset += BigInt(new TextEncoder().encode(text.slice(0, complete)).length)
        yield* PubSub.publishAll(pubsub, yield* parse(text.slice(0, complete)))
      })
      yield* poll.pipe(
        Effect.catch((error) => Effect.logWarning("journal tail", error)),
        Effect.repeat(Schedule.spaced("250 millis")),
        Effect.forkScoped
      )

      const publish = Effect.fn("EventBus.publish")(function*(event: AgentEvent) {
        const line = JSON.stringify(Schema.encodeSync(AgentEvent)(event)) + "\n"
        yield* fs.writeFileString(journal, line, { flag: "a" }).pipe(Effect.mapError(fail("append journal")))
      })

      const history = fs.exists(journal).pipe(
        Effect.flatMap((exists) => exists ? fs.readFileString(journal) : Effect.succeed("")),
        Effect.mapError(fail("read journal")),
        Effect.flatMap(parse)
      )

      return EventBus.of({ publish, subscribe: Stream.fromPubSub(pubsub), history })
    })
  )
}

export const makeEvent = (fields: Omit<AgentEvent, "id" | "at">) =>
  Effect.gen(function*() {
    const now = yield* DateTime.now
    return new AgentEvent({ ...fields, id: crypto.randomUUID(), at: DateTime.formatIso(now) })
  })
