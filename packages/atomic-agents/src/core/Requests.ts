import { Effect, Option, Schema, Stream } from "effect"
import { type Agent, Agents } from "./Agent.ts"
import { publishRequest } from "./Ask.ts"
import { type JobInfo, Trigger } from "./Component.ts"
import { type AgentEvent, EventBus, lifecycle } from "./Event.ts"
import { uuid } from "./Id.ts"
import { events as runtimeEvents, publishRuntime, RUNTIME } from "./RuntimeEvents.ts"
import { effective, Settings } from "./Settings.ts"

/**
 * Asking any agent from outside the service: the `relay` MCP server's `agents_list`, `agents_ask` and
 * `agents_result` (Eva's `.omp/tools/relay-mcp.ts`) call `atomic-agents catalog|request|result`, which land here.
 * An agent with an ask pair gets its request event (`Ask.ts`); any other agent gets `atomic-agents/run.requested`
 * for its job. Either way the service runs it and its `job.started` names the request, so the run's status is read
 * back from the journal by `requestId` (the run id callers hold) and a long run outlives the caller that asked.
 */

/** How a caller reaches an agent: its ask pair, else its job run on request. */
type Target =
  | { readonly how: "ask"; readonly agent: Agent; readonly job: JobInfo; readonly request: string; readonly reply: string }
  | { readonly how: "run"; readonly agent: Agent; readonly job: JobInfo }

const RUN_REQUESTED = `${RUNTIME}/run.requested`
const RUN_REJECTED = `${RUNTIME}/run.rejected`

/** The ask pair's job is the one its request triggers; without a pair, the first job anyone may start by hand. */
const targetOf = (agent: Agent): Target | undefined => {
  if (agent.asks !== undefined) {
    const type = `${agent.id}/${agent.asks.request}`
    const job = agent.jobs.find((candidate) => candidate.triggers.some((trigger) => Trigger.$is("OnEvent")(trigger) && trigger.type === type)) ?? agent.jobs[0]
    if (job !== undefined) return { how: "ask", agent, job, request: agent.asks.request, reply: agent.asks.reply }
  }
  const job = agent.jobs.find((candidate) => candidate.triggers.some(Trigger.$is("Manual"))) ?? agent.jobs[0]
  return job === undefined ? undefined : { how: "run", agent, job }
}

type JsonSchema = Record<string, unknown>

/** A schema as JSON Schema (draft 2020-12) without `drop` fields: `requestId` is the caller's run id, never the caller's to write. */
const jsonSchema = (schema: Schema.Top, drop: ReadonlyArray<string> = []): JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema)
  const root = { ...document.schema } as JsonSchema & { properties?: Record<string, unknown>; required?: ReadonlyArray<string> }
  if (root.properties !== undefined) root.properties = Object.fromEntries(Object.entries(root.properties).filter(([key]) => !drop.includes(key)))
  if (root.required !== undefined) root.required = root.required.filter((key) => !drop.includes(key))
  return Object.keys(document.definitions).length === 0 ? root : { ...root, $defs: document.definitions }
}

const requestSchema = (target: Target) =>
  target.how === "ask" ? jsonSchema(target.agent.events[target.request] as Schema.Top, ["requestId"]) : jsonSchema(target.job.input)

/** A run's events, other than the request it answers, as the reply: an ask pair's reply event, else every event the job emitted. */
const replySchema = (target: Target): JsonSchema => {
  if (target.how === "ask") return jsonSchema(target.agent.events[target.reply] as Schema.Top, ["requestId"])
  const inputs = new Set(target.job.triggers.flatMap((trigger) => Trigger.$is("OnEvent")(trigger) ? [trigger.type] : []))
  const events = Object.fromEntries(Object.entries(target.agent.events)
    .filter(([name]) => !inputs.has(`${target.agent.id}/${name}`))
    .map(([name, schema]) => [name, jsonSchema(schema as Schema.Top)]))
  return {
    type: "object",
    description: "Every event the run emitted, in order: {type, data} with data per the event's schema.",
    properties: { events: { type: "array", items: { type: "object", properties: { type: { enum: Object.keys(events) }, data: {} } } } },
    "x-events": events
  }
}

const decodeRunRequested = Schema.decodeUnknownOption(runtimeEvents["run.requested"])
const decodeRunRejected = Schema.decodeUnknownOption(runtimeEvents["run.rejected"])
const decodeCorrelated = Schema.decodeUnknownOption(Schema.Struct({ requestId: Schema.String }))
/** The stats an output or summary event may carry (`AgentSpec.ts` ITEM_STATS, SUMMARY_STATS). */
const decodeStats = Schema.decodeUnknownOption(Schema.Struct({
  cost: Schema.optionalKey(Schema.Number),
  seconds: Schema.optionalKey(Schema.Number),
  modelCalls: Schema.optionalKey(Schema.Number)
}))

/** Whether an event's data names this request (requests and replies of ask pairs; job inputs of their runs). */
const carries = (data: unknown, requestId: string) => Option.exists(decodeCorrelated(data), (correlated) => correlated.requestId === requestId)

/** Request and reply data as the caller sees them: the correlation id is the run id, said once. Both were schema-checked objects when written. */
const withoutRequestId = (data: unknown) => {
  const { requestId: _drop, ...rest } = data as Readonly<Record<string, unknown>>
  return rest
}

/** USD a run cost: its summary's total when it has one (`modelCalls` marks it), else the sum over its events. */
const costOf = (events: ReadonlyArray<AgentEvent>): number | undefined => {
  const costs = events.flatMap((event) => Option.match(decodeStats(event.data), {
    onNone: () => [],
    onSome: (stats) => stats.cost === undefined ? [] : [{ cost: stats.cost, summary: stats.modelCalls !== undefined }]
  }))
  if (costs.length === 0) return undefined
  return costs.find((entry) => entry.summary)?.cost ?? costs.reduce((sum, entry) => sum + entry.cost, 0)
}

const median = (values: ReadonlyArray<number>): number | undefined => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** What an agent takes and gives, and what its last successful runs took: the `agents_list` entry. */
export interface CatalogEntry {
  readonly id: string
  readonly purpose: string
  /** `ask`: its request/reply event pair; `run`: its job, started on request. */
  readonly how: "ask" | "run"
  readonly job: string
  readonly description: string
  /** JSON Schema of the request (what `request` takes). */
  readonly request: JsonSchema
  readonly required: ReadonlyArray<string>
  /** JSON Schema of the reply. */
  readonly reply: JsonSchema
  readonly model: string
  readonly thinking?: string
  /** Medians over the last successful runs (at most 20); absent when it never ran. */
  readonly typical: { readonly runs: number; readonly seconds?: number; readonly cost?: number }
}

const RECENT = 20

/** Every enabled agent that answers requests, in load order, with its typical latency and cost from the journal. */
export const catalog = Effect.gen(function*() {
  const settings = yield* (yield* Settings).current
  const agents = yield* (yield* Agents).current
  const history = yield* (yield* EventBus).history
  const runs = new Map<string, { component: string; events: Array<AgentEvent>; seconds?: number }>()
  for (const event of history) {
    if (event.component === RUNTIME || event.job === "ask") continue
    const key = `${event.component} ${event.run}`
    const entry = runs.get(key) ?? { component: event.component, events: [] }
    runs.set(key, entry)
    const phase = lifecycle(event)
    if (Option.isNone(phase)) entry.events.push(event)
    else if (phase.value._tag === "job.succeeded") entry.seconds = phase.value.seconds
  }
  const done = [...runs.values()].filter((run) => run.seconds !== undefined)
  return agents.flatMap((agent): ReadonlyArray<CatalogEntry> => {
    const resolved = effective(agent, settings)
    const target = targetOf(agent)
    if (!resolved.enabled || target === undefined) return []
    const recent = done.filter((run) => run.component === agent.id).slice(-RECENT)
    const seconds = median(recent.map((run) => run.seconds!))
    const cost = median(recent.flatMap((run) => costOf(run.events) ?? []))
    const request = requestSchema(target)
    return [{
      id: agent.id,
      purpose: agent.purpose,
      how: target.how,
      job: target.job.id,
      description: target.job.description,
      request,
      required: (request["required"] as ReadonlyArray<string> | undefined) ?? [],
      reply: replySchema(target),
      model: resolved.agent.model,
      ...(resolved.agent.thinking === undefined ? {} : { thinking: resolved.agent.thinking }),
      typical: { runs: recent.length, ...(seconds === undefined ? {} : { seconds: Math.round(seconds * 10) / 10 }), ...(cost === undefined ? {} : { cost: Math.round(cost * 10000) / 10000 }) }
    }]
  })
})

/** A run as `agents_ask` and `agents_result` answer it; `run` is the request id. */
export interface RunStatus {
  readonly run: string
  readonly agent: string
  readonly status: "running" | "done" | "failed"
  readonly request?: unknown
  readonly reply?: unknown
  /** The reply's one-text answer (an ask pair's `show` field), when it has one. */
  readonly text?: string
  readonly error?: string
  readonly model?: string
  readonly requestedAt?: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly seconds?: number
  readonly cost?: number
}

/** A request that cannot be sent: no such agent, disabled, or a request its schema rejects (`schema` says what it takes). */
export class RequestError extends Schema.TaggedError<RequestError>()("RequestError", {
  message: Schema.String,
  schema: Schema.optionalKey(Schema.Unknown)
}) {}

export class UnknownRun extends Schema.TaggedError<UnknownRun>()("UnknownRun", {
  message: Schema.String
}) {}

/** One request's run, folded from journal events in order (history, then live; an event seen twice counts once). */
class Tracker {
  private readonly seen = new Set<string>()
  agent: string | undefined
  request: unknown
  requestedAt: string | undefined
  rejected: string | undefined
  started: { readonly component: string; readonly run: string; readonly at: string; readonly model: string } | undefined
  finished: { readonly ok: boolean; readonly at: string; readonly seconds: number; readonly error?: string } | undefined
  readonly outputs: Array<AgentEvent> = []

  constructor(readonly requestId: string) {}

  add(event: AgentEvent): void {
    if (this.seen.has(event.id)) return
    this.seen.add(event.id)
    if (event.type === RUN_REQUESTED) {
      const asked = Option.getOrUndefined(decodeRunRequested(event.data))
      if (asked?.requestId === this.requestId) {
        this.agent = asked.agent
        this.request = asked.input
        this.requestedAt = event.at
      }
      return
    }
    if (event.type === RUN_REJECTED) {
      const rejected = Option.getOrUndefined(decodeRunRejected(event.data))
      if (rejected?.requestId === this.requestId) {
        this.agent ??= rejected.agent
        this.rejected = rejected.error
      }
      return
    }
    if (event.job === "ask") {
      if (carries(event.data, this.requestId)) {
        this.agent = event.component
        this.request = withoutRequestId(event.data)
        this.requestedAt = event.at
      }
      return
    }
    const phase = lifecycle(event)
    if (Option.isSome(phase) && phase.value._tag === "job.started") {
      if (phase.value.requestId === this.requestId || carries(phase.value.input, this.requestId)) {
        this.agent ??= event.component
        this.started = { component: event.component, run: event.run, at: event.at, model: phase.value.model }
      }
      return
    }
    if (this.started === undefined || event.run !== this.started.run || event.component !== this.started.component) return
    if (Option.isNone(phase)) this.outputs.push(event)
    else if (phase.value._tag === "job.succeeded") this.finished = { ok: true, at: event.at, seconds: phase.value.seconds }
    else if (phase.value._tag === "job.failed") this.finished = { ok: false, at: event.at, seconds: phase.value.seconds, error: phase.value.message }
  }

  /** An ask pair's reply: the output carrying this request's id. */
  get reply(): AgentEvent | undefined {
    return this.outputs.find((event) => carries(event.data, this.requestId))
  }

  get known(): boolean {
    return this.agent !== undefined
  }

  get done(): boolean {
    return this.rejected !== undefined || this.finished !== undefined || this.reply !== undefined
  }

  status(agents: ReadonlyArray<Agent>): RunStatus {
    const reply = this.reply
    const failed = this.rejected ?? (reply === undefined && this.finished?.ok === false ? this.finished.error : undefined)
    const data = reply === undefined
      ? this.finished?.ok ? { events: this.outputs.map((event) => ({ type: event.type.slice(event.type.indexOf("/") + 1), data: event.data })) } : undefined
      : withoutRequestId(reply.data)
    const shown = reply === undefined ? undefined : agents.find((agent) => agent.id === this.agent)?.asks?.show(reply.data)
    const seconds = this.finished?.seconds ?? (reply === undefined ? undefined : Option.getOrUndefined(decodeStats(reply.data))?.seconds)
    const cost = costOf(reply === undefined ? this.outputs : [reply])
    return {
      run: this.requestId,
      agent: this.agent ?? "",
      status: failed !== undefined ? "failed" : data !== undefined ? "done" : "running",
      ...(this.request === undefined ? {} : { request: this.request }),
      ...(data === undefined ? {} : { reply: data }),
      ...(shown === undefined || shown === "none" ? {} : { text: shown }),
      ...(failed === undefined ? {} : { error: failed }),
      ...(this.started === undefined ? {} : { model: this.started.model, startedAt: this.started.at }),
      ...(this.requestedAt === undefined ? {} : { requestedAt: this.requestedAt }),
      ...(this.finished === undefined && reply === undefined ? {} : { finishedAt: this.finished?.at ?? reply!.at }),
      ...(seconds === undefined ? {} : { seconds }),
      ...(cost === undefined ? {} : { cost })
    }
  }
}

/**
 * Fold the journal into `requestId`'s run, then follow live events for up to `waitMillis` until it is done.
 * `live` must be subscribed before the request was published, so nothing between the two slips past.
 */
const follow = (requestId: string, live: Stream.Stream<AgentEvent>, waitMillis: number) =>
  Effect.gen(function*() {
    const agents = yield* (yield* Agents).current
    const tracker = new Tracker(requestId)
    for (const event of yield* (yield* EventBus).history) tracker.add(event)
    if (!tracker.known) return yield* new UnknownRun({ message: `no request ${requestId} in the journal` })
    if (!tracker.done && waitMillis > 0) {
      yield* Stream.runForEachWhile(live, (event) => Effect.sync(() => {
        tracker.add(event)
        return !tracker.done
      })).pipe(Effect.timeoutOption(waitMillis))
    }
    return tracker.status(agents)
  })

/**
 * Send `data` to `agentId` and wait up to `waitMillis` for its answer: `done` or `failed`, else `running` with the
 * run id `result` takes. The request is checked against the agent's schema before anything is sent.
 */
export const request = Effect.fn("Requests.request")(function*(agentId: string, data: Readonly<Record<string, unknown>>, waitMillis: number) {
  const agents = yield* (yield* Agents).current
  const settings = yield* (yield* Settings).current
  const agent = agents.find((candidate) => candidate.id === agentId)
  const askable = agents.filter((candidate) => effective(candidate, settings).enabled && targetOf(candidate) !== undefined).map((candidate) => candidate.id)
  if (agent === undefined) return yield* new RequestError({ message: `no agent ${agentId} (have: ${askable.join(", ")})` })
  if (!effective(agent, settings).enabled) return yield* new RequestError({ message: `${agentId} is disabled in ${(yield* Settings).file}` })
  const target = targetOf(agent)
  if (target === undefined) return yield* new RequestError({ message: `${agentId} has no job to run` })
  const invalid = (error: Schema.SchemaError) =>
    Effect.fail(new RequestError({ message: `${agentId} rejects this request: ${error.message}`, schema: requestSchema(target) }))
  const bus = yield* EventBus
  const live = yield* bus.listen
  let requestId: string
  if (target.how === "ask") {
    requestId = yield* publishRequest(agent, { request: target.request, reply: target.reply }, data).pipe(Effect.catchTag("SchemaError", invalid))
  } else {
    yield* Schema.decodeUnknownEffect(target.job.input as Schema.Codec<unknown>)(data).pipe(Effect.catchTag("SchemaError", invalid))
    requestId = yield* uuid
    yield* publishRuntime(bus, "run.requested", { requestId, agent: agent.id, job: target.job.id, input: data as Schema.Json }, "ask")
  }
  return yield* follow(requestId, live, waitMillis)
}, Effect.scoped)

/** `requestId`'s run as it stands, waiting up to `waitMillis` for it to finish. */
export const result = Effect.fn("Requests.result")(function*(requestId: string, waitMillis: number) {
  const live = yield* (yield* EventBus).listen
  return yield* follow(requestId, live, waitMillis)
}, Effect.scoped)
