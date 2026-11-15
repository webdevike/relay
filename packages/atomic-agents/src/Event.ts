import { Config, Context, DateTime, Effect, FileSystem, Layer, Option, Path, PubSub, Ref, Schedule, Schema, type Scope, Semaphore, Stream } from "effect"
import { ToolMode } from "./Component.ts"
import { uuid } from "./Id.ts"

/**
 * The one envelope every component event travels in. `type` is `<component>/<name>`;
 * `data` was validated against the component's declared schema before it was written.
 * Runtime lifecycle events (`<component>/job.started|job.succeeded|job.failed`, see `Lifecycle`) use the same shape.
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

const JournalLine = Schema.fromJsonString(AgentEvent)
const decodeLine = Schema.decodeUnknownEffect(JournalLine)
const encodeLine = Schema.encodeEffect(JournalLine)

/**
 * The runtime's lifecycle events, declared once. The runtime wraps every run in them, so any subscriber can
 * follow any component without knowing its schemas. On the wire the `_tag` is the event name (the envelope's
 * `type` is `<component>/<_tag>`) and travels in `data` too, so `Schema.decodeUnknownEffect(Lifecycle)(event.data)` works.
 * `job.started`'s `toolMode` is the mode the run's model used its tools in; absent for a chef without tools (and in lines
 * written before tool modes).
 */
export const JobStarted = Schema.TaggedStruct("job.started", { input: Schema.Unknown, model: Schema.String, toolMode: Schema.optionalKey(ToolMode) })
export const JobSucceeded = Schema.TaggedStruct("job.succeeded", { model: Schema.String, seconds: Schema.Number })
export const JobFailed = Schema.TaggedStruct("job.failed", {
  model: Schema.String,
  seconds: Schema.Number,
  /** The failure's `_tag`, or `Defect`. */
  error: Schema.String,
  message: Schema.String
})
export const Lifecycle = Schema.Union([JobStarted, JobSucceeded, JobFailed])
export type Lifecycle = typeof Lifecycle.Type

const decodeLifecycle = Schema.decodeUnknownOption(Lifecycle)

/** The lifecycle event an envelope carries, if any. The tag comes from the envelope type, so journal lines written before `data` carried `_tag` decode too. */
export const lifecycle = (event: AgentEvent): Option.Option<Lifecycle> =>
  typeof event.data === "object" && event.data !== null
    ? decodeLifecycle({ ...event.data, _tag: event.type.slice(event.type.indexOf("/") + 1) })
    : Option.none()

export class JournalError extends Schema.TaggedError<JournalError>()("JournalError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

/** Where events, runs and artifacts live: Relay's data dir (`~/.config/relay/atomic-agents`) unless overridden. */
export class Home extends Context.Service<Home, {
  readonly root: string
  readonly journal: string
  runDir(component: string, run: string): string
  /** A component's state that outlives runs (cursors, caches): `<root>/state/<component>`. */
  stateDir(component: string): string
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
        runDir: (component, run) => path.join(root, "runs", component, run),
        stateDir: (component) => path.join(root, "state", component)
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
  /** Events appended after this subscription opened (when the stream starts running); use `history` for the past. */
  readonly subscribe: Stream.Stream<AgentEvent>
  /** Subscribe now, for the scope: the stream holds every event appended after this returns, so a reply to your own publish cannot slip past it. */
  readonly listen: Effect.Effect<Stream.Stream<AgentEvent>, never, Scope.Scope>
  /** The whole journal, oldest first. */
  readonly history: Effect.Effect<ReadonlyArray<AgentEvent>, JournalError>
  /** The newest event of `type` appended since this bus started, after reading the journal up to its current end (any process's appends count). */
  latest(type: string): Effect.Effect<Option.Option<AgentEvent>, JournalError>
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

      // A torn or hand-edited line is logged and skipped; it must not hide the rest of the journal.
      const parse = (text: string) =>
        Effect.forEach(
          text.split("\n").filter((line) => line.trim() !== ""),
          (line) =>
            decodeLine(line).pipe(
              Effect.tapError((error) => Effect.logWarning(`skipped bad journal line: ${line.slice(0, 200)}`, error.message)),
              Effect.option
            )
        ).pipe(Effect.map((events) => events.flatMap((event) => Option.isSome(event) ? [event.value] : [])))

      // Tail from the current end: a new bus never replays old history as live events.
      const offset = yield* Ref.make(yield* size)
      const newest = yield* Ref.make<ReadonlyMap<string, AgentEvent>>(new Map())
      const lock = yield* Semaphore.make(1)
      /** Read what was appended since the last read, remember the newest event per type, fan it out. */
      const tail = Effect.gen(function*() {
        const end = yield* size
        const last = yield* Ref.get(offset)
        const from = end < last ? 0n : last // journal was rotated
        if (end === from) return yield* Ref.set(offset, from)
        const chunk = yield* Effect.scoped(Effect.gen(function*() {
          const file = yield* fs.open(journal, { flag: "r" })
          return yield* file.readAlloc(Number(end - from), { position: from })
        })).pipe(Effect.mapError(fail("read journal")))
        if (Option.isNone(chunk)) return
        const text = new TextDecoder().decode(chunk.value)
        const complete = text.slice(0, text.lastIndexOf("\n") + 1) // a writer may be mid-line
        yield* Ref.set(offset, from + BigInt(new TextEncoder().encode(complete).length))
        const events = yield* parse(complete)
        yield* Ref.update(newest, (map) => new Map([...map, ...events.map((event) => [event.type, event] as const)]))
        yield* PubSub.publishAll(pubsub, events)
      }).pipe(lock.withPermits(1))
      // A failed read leaves the offset where it was, so the next tick retries it and nothing is lost.
      yield* tail.pipe(
        Effect.catch((error) => Effect.logWarning("journal tail", error.message)),
        // 50 ms: a request/response (`Ask.ts`) crosses the journal twice; a stat per tick is all it costs when idle.
        Effect.repeat(Schedule.spaced("50 millis")),
        Effect.forkScoped
      )

      const publish = Effect.fn("EventBus.publish")(function*(event: AgentEvent) {
        const line = yield* encodeLine(event).pipe(Effect.mapError(fail(`encode ${event.type}`)))
        yield* fs.writeFileString(journal, `${line}\n`, { flag: "a" }).pipe(Effect.mapError(fail("append journal")))
      })

      const history = fs.exists(journal).pipe(
        Effect.flatMap((exists) => exists ? fs.readFileString(journal) : Effect.succeed("")),
        Effect.mapError(fail("read journal")),
        Effect.flatMap(parse)
      )

      const latest = Effect.fn("EventBus.latest")(function*(type: string) {
        yield* tail
        return Option.fromUndefinedOr((yield* Ref.get(newest)).get(type))
      })

      return EventBus.of({
        publish,
        subscribe: Stream.fromPubSub(pubsub),
        listen: Effect.map(PubSub.subscribe(pubsub), Stream.fromSubscription),
        history,
        latest
      })
    })
  )
}

export const makeEvent = (fields: Omit<AgentEvent, "id" | "at">) =>
  Effect.gen(function*() {
    const now = yield* DateTime.now
    return new AgentEvent({ ...fields, id: yield* uuid, at: DateTime.formatIso(now) })
  })
