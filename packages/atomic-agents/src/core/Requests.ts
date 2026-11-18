import { DateTime, Effect, Option, Path, Schema, Stream } from "effect"
import { type Agent, Agents } from "./Agent.ts"
import { AGENT_DOC } from "./AgentDoc.ts"
import { ASK_RUN_PREFIX, publishRequest } from "./Ask.ts"
import { type JobInfo, Trigger } from "./Component.ts"
import { type AgentEvent, EventBus, lifecycle } from "./Event.ts"
import { uuid } from "./Id.ts"
import { events as runtimeEvents, publishRuntime, RUNTIME } from "./RuntimeEvents.ts"
import { effective, Settings } from "./Settings.ts"

/**
 * Asking any agent from outside the service: the `relay` MCP server's `agents_list`, `agents_ask`,
 * `agents_result` and `agents_runs` (Eva's `.omp/tools/relay-mcp.ts`) call `atomic-agents catalog|request|result|runs`,
 * which land here. An agent with an ask pair gets its request event (`Ask.ts`); any other agent gets
 * `atomic-agents/run.requested` for its job. Either way the service runs it and its `job.started` names the request,
 * so the run's status is read back from the journal by `requestId` (the run id callers hold) and a long run outlives
 * the caller that asked. The request's envelope names its `caller`, so `runs` says who used which agent.
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

/** A run as `agents_ask` and `agents_result` answer it; `run` is the request id, or the job run id of a run no request started. */
export interface RunStatus {
  readonly run: string
  readonly agent: string
  /** The job it ran (`job.started`'s job); absent until it started. */
  readonly job?: string
  readonly status: "running" | "done" | "failed"
  /** Who asked (`AgentEvent.caller`: `agent:nova`, an omp session file); absent when the request did not say. */
  readonly caller?: string
  readonly request?: unknown
  readonly reply?: unknown
  /** The reply's one-text answer (an ask pair's `show` field), when it has one. */
  readonly text?: string
  readonly error?: string
  readonly model?: string
  /** The thinking level the run's agent was set to, when it has one. */
  readonly thinking?: string
  /** The run is on the backup model: the main one failed first (`job.started`'s `fellBackFrom`). */
  readonly fellBack?: boolean
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

/**
 * One run, folded from journal events in order (history, then live; an event seen twice counts once): a request's run
 * (`requestId` is the request id), or with `jobRun` a job run no request started (cron, onEvent, manual, bench), where
 * `requestId` is the job run id and `request` the job's input.
 */
class Tracker {
  private readonly seen = new Set<string>()
  agent: string | undefined
  caller: string | undefined
  request: unknown
  requestedAt: string | undefined
  rejected: string | undefined
  started: { readonly component: string; readonly job: string; readonly run: string; readonly at: string; readonly model: string; readonly thinking?: string; readonly fellBack?: boolean } | undefined
  finished: { readonly ok: boolean; readonly at: string; readonly seconds: number; readonly error?: string } | undefined
  readonly outputs: Array<AgentEvent> = []

  constructor(readonly requestId: string, readonly jobRun = false) {}

  add(event: AgentEvent): void {
    if (this.seen.has(event.id)) return
    this.seen.add(event.id)
    if (event.type === RUN_REQUESTED) {
      const asked = Option.getOrUndefined(decodeRunRequested(event.data))
      if (asked?.requestId === this.requestId) {
        this.agent = asked.agent
        this.caller = event.caller
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
        this.caller = event.caller
        this.request = withoutRequestId(event.data)
        this.requestedAt = event.at
      }
      return
    }
    const phase = lifecycle(event)
    if (Option.isSome(phase) && phase.value._tag === "job.started") {
      const mine = this.jobRun
        ? event.run === this.requestId && (this.started === undefined || this.started.component === event.component)
        : phase.value.requestId === this.requestId || carries(phase.value.input, this.requestId)
      if (mine) {
        this.agent ??= event.component
        if (this.jobRun && this.request === undefined && typeof phase.value.input === "object" && phase.value.input !== null && !Array.isArray(phase.value.input)) {
          const input = withoutRequestId(phase.value.input)
          if (Object.keys(input).length > 0) this.request = input
        }
        this.started = { component: event.component, job: event.job, run: event.run, at: event.at, model: phase.value.model, ...(phase.value.thinking === undefined ? {} : { thinking: phase.value.thinking }), ...(phase.value.fellBackFrom === undefined ? {} : { fellBack: true }) }
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
      ...(this.caller === undefined ? {} : { caller: this.caller }),
      ...(this.request === undefined ? {} : { request: this.request }),
      ...(data === undefined ? {} : { reply: data }),
      ...(shown === undefined || shown === "none" ? {} : { text: shown }),
      ...(failed === undefined ? {} : { error: failed }),
      ...(this.started === undefined ? {} : { job: this.started.job, model: this.started.model, ...(this.started.thinking === undefined ? {} : { thinking: this.started.thinking }), ...(this.started.fellBack === true ? { fellBack: true } : {}), startedAt: this.started.at }),
      ...(this.requestedAt === undefined ? {} : { requestedAt: this.requestedAt }),
      ...(this.finished === undefined && reply === undefined ? {} : { finishedAt: this.finished?.at ?? reply!.at }),
      ...(seconds === undefined ? {} : { seconds }),
      ...(cost === undefined ? {} : { cost })
    }
  }
}

/**
 * Fold the journal into run `run` (a request id, else a job run id), then follow live events for up to `waitMillis` until it is done.
 * `live` must be subscribed before the request was published, so nothing between the two slips past.
 */
const follow = (run: string, live: Stream.Stream<AgentEvent>, waitMillis: number) =>
  Effect.gen(function*() {
    const agents = yield* (yield* Agents).current
    const history = yield* (yield* EventBus).history
    let tracker = new Tracker(run)
    for (const event of history) tracker.add(event)
    if (!tracker.known) {
      tracker = new Tracker(run, true)
      for (const event of history) tracker.add(event)
    }
    if (!tracker.known) return yield* new UnknownRun({ message: `no run ${run} in the journal` })
    if (!tracker.done && waitMillis > 0) {
      const following = tracker
      yield* Stream.runForEachWhile(live, (event) => Effect.sync(() => {
        following.add(event)
        return !following.done
      })).pipe(Effect.timeoutOption(waitMillis))
    }
    return tracker.status(agents)
  })

/**
 * Send `data` to `agentId` and wait up to `waitMillis` for its answer: `done` or `failed`, else `running` with the
 * run id `result` takes. The request is checked against the agent's schema before anything is sent. `caller` (who
 * asks, `AgentEvent.caller`) goes on the request's envelope, so `runs` can say who used which agent.
 */
export const request = Effect.fn("Requests.request")(function*(agentId: string, data: Readonly<Record<string, unknown>>, waitMillis: number, caller?: string) {
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
    requestId = yield* publishRequest(agent, { request: target.request, reply: target.reply }, data, caller).pipe(Effect.catchTag("SchemaError", invalid))
  } else {
    yield* Schema.decodeUnknownEffect(target.job.input as Schema.Codec<unknown>)(data).pipe(Effect.catchTag("SchemaError", invalid))
    requestId = yield* uuid
    yield* publishRuntime(bus, "run.requested", { requestId, agent: agent.id, job: target.job.id, input: data as Schema.Json }, "ask", caller)
  }
  return yield* follow(requestId, live, waitMillis)
}, Effect.scoped)

/** Run `run` (a request id, or the job run id of any job run) as it stands, waiting up to `waitMillis` for it to finish. */
export const result = Effect.fn("Requests.result")(function*(run: string, waitMillis: number) {
  const live = yield* (yield* EventBus).listen
  return yield* follow(run, live, waitMillis)
}, Effect.scoped)

/**
 * Every request sent through `request` or `ask`, folded into its run, oldest first: a `run.requested`, or an ask
 * pair's request in an `ask-` run (`publishRequest`). Consumers' own asks on the bus (the Relay Host's widget asks
 * under replies, `relay-` runs) are not specialist calls and stay out. With `every`, every job run no request
 * started (cron, onEvent, manual, bench, a consumer's own ask) is in it too, from its `job.started`. One pass over
 * the journal: each request's events reach its tracker by request id, then by the run its `job.started` names.
 */
const foldRuns = (history: ReadonlyArray<AgentEvent>, every: boolean): ReadonlyArray<Tracker> => {
  const byRequest = new Map<string, Tracker>()
  const byRun = new Map<string, Tracker>()
  const ordered: Array<Tracker> = []
  const open = (requestId: string): Tracker => {
    const known = byRequest.get(requestId)
    if (known !== undefined) return known
    const tracker = new Tracker(requestId)
    byRequest.set(requestId, tracker)
    ordered.push(tracker)
    return tracker
  }
  for (const event of history) {
    if (event.type === RUN_REQUESTED) {
      const asked = Option.getOrUndefined(decodeRunRequested(event.data))
      if (asked !== undefined) open(asked.requestId).add(event)
      continue
    }
    if (event.type === RUN_REJECTED) {
      const rejected = Option.getOrUndefined(decodeRunRejected(event.data))
      if (rejected !== undefined) byRequest.get(rejected.requestId)?.add(event)
      continue
    }
    if (event.job === "ask") {
      const asked = Option.getOrUndefined(decodeCorrelated(event.data))
      if (asked !== undefined && event.run.startsWith(ASK_RUN_PREFIX)) open(asked.requestId).add(event)
      continue
    }
    const phase = lifecycle(event)
    if (Option.isSome(phase) && phase.value._tag === "job.started") {
      const key = `${event.component} ${event.run}`
      const requestId = phase.value.requestId ?? Option.getOrUndefined(decodeCorrelated(phase.value.input))?.requestId
      let tracker = requestId === undefined ? undefined : byRequest.get(requestId)
      // A trial arm no request started is listed by its trial (blind until Isaac picks), not as a job run.
      const arm = typeof event.data === "object" && event.data !== null && "trial" in event.data
      if (tracker === undefined && every && event.component !== RUNTIME && !arm) {
        // A retry on the fallback model starts the same run again.
        tracker = byRun.get(key)
        if (tracker === undefined) {
          tracker = new Tracker(event.run, true)
          ordered.push(tracker)
        }
      }
      if (tracker !== undefined) {
        tracker.add(event)
        byRun.set(key, tracker)
      }
      continue
    }
    byRun.get(`${event.component} ${event.run}`)?.add(event)
  }
  return ordered
}

/** A run as `runs` lists it: its status without the request and reply (`result` has them), the request on one line. */
export interface RunSummary extends Omit<RunStatus, "request" | "reply" | "text"> {
  /** The request's first text field (else its JSON), on one line, at most `SUMMARY_MAX` characters. */
  readonly summary?: string
}

/** One agent's use over the window. */
export interface AgentUsage {
  readonly agent: string
  readonly calls: number
  readonly failed: number
  /** USD over the runs that report a cost. */
  readonly cost: number
  /** Calls per caller, most first; no `caller` for requests that did not say who asked. */
  readonly callers: ReadonlyArray<{ readonly caller?: string; readonly calls: number }>
}

/** What `runs` answers: the newest runs, and each agent's use since `since`. */
export interface RunsReport {
  readonly since: string
  readonly days: number
  /** Newest first, at most `limit`, of any age. */
  readonly runs: ReadonlyArray<RunSummary>
  /** Every agent asked since `since`, most calls first. */
  readonly agents: ReadonlyArray<AgentUsage>
}

export const SUMMARY_MAX = 160

/** The request in one line: its first non-empty text field (`question`, `url`, ...), else its JSON. */
export const summaryOf = (request: unknown): string | undefined => {
  if (request === undefined) return undefined
  const fields = typeof request === "object" && request !== null && !Array.isArray(request) ? Object.values(request) : []
  const text = fields.find((value): value is string => typeof value === "string" && value.trim() !== "") ?? JSON.stringify(request)
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line
}

const DAY_MILLIS = 86_400_000

/**
 * Who used which agent: the newest `limit` runs (of `agent` when given; with `every` job runs no request started too),
 * and per agent its calls (requests only), failures, cost and callers over the last `days`.
 */
export const runs = Effect.fn("Requests.runs")(function*(options: { readonly days: number; readonly limit: number; readonly agent?: string; readonly every?: boolean }) {
  const agents = yield* (yield* Agents).current
  const history = yield* (yield* EventBus).history
  const since = DateTime.toEpochMillis(yield* DateTime.now) - options.days * DAY_MILLIS
  const all = foldRuns(history, options.every ?? false)
    .filter((tracker) => tracker.known && (options.agent === undefined || tracker.agent === options.agent))
    .map((tracker) => tracker.status(agents))
  const usage = new Map<string, { calls: number; failed: number; cost: number; callers: Map<string | undefined, number> }>()
  for (const run of all) {
    if (run.requestedAt === undefined || Date.parse(run.requestedAt) < since) continue
    const entry = usage.get(run.agent) ?? { calls: 0, failed: 0, cost: 0, callers: new Map() }
    usage.set(run.agent, entry)
    entry.calls += 1
    if (run.status === "failed") entry.failed += 1
    entry.cost += run.cost ?? 0
    entry.callers.set(run.caller, (entry.callers.get(run.caller) ?? 0) + 1)
  }
  const report: RunsReport = {
    since: new Date(since).toISOString(),
    days: options.days,
    runs: (options.limit > 0 ? all.slice(-options.limit) : []).reverse().map(({ request, reply: _reply, text: _text, ...rest }) => {
      const summary = summaryOf(request)
      return summary === undefined ? rest : { ...rest, summary }
    }),
    agents: [...usage].map(([agent, entry]): AgentUsage => ({
      agent,
      calls: entry.calls,
      failed: entry.failed,
      cost: Math.round(entry.cost * 10000) / 10000,
      callers: [...entry.callers]
        .sort((a, b) => b[1] - a[1])
        .map(([caller, calls]) => caller === undefined ? { calls } : { caller, calls })
    })).sort((a, b) => b.calls - a.calls)
  }
  return report
})

/** An agent's job runs in the journal, requested or not. */
export interface RunStats {
  /** Runs started in the last 7 days. */
  readonly week: number
  /** Of those, the ones that ended with `job.failed`. */
  readonly failed: number
  /** Runs started in the last hour that have not ended (older unfinished runs are taken as dead). */
  readonly running: number
  /** When the newest run started. */
  readonly lastAt?: string
}

/** An agent as the Relay Agents page lists it: every agent file and code agent, enabled or not, and files that failed to load. */
export interface RosterEntry {
  readonly id: string
  /** Empty for a file that never loaded. */
  readonly purpose: string
  readonly kind: "spec" | "code"
  /** The agent file (a folder's `AGENT.md`, or `<id>.json|yaml|yml`); absent for code the host passed in. */
  readonly file?: string
  /** A JSON/YAML spec's knowledge files, absolute; empty for an `AGENT.md` folder (its `knowledge/` is inside it) and code. */
  readonly knowledge: ReadonlyArray<string>
  readonly enabled: boolean
  /** config.json's `mode`, when set. */
  readonly mode?: "shadow" | "live" | "off"
  /** The model in force; empty when the file never loaded. */
  readonly model: string
  readonly fallbackModel?: string
  readonly candidates: ReadonlyArray<string>
  readonly thinking?: string
  /** How a request reaches it (as `catalog`); absent when it has no job. */
  readonly how?: "ask" | "run"
  readonly job?: string
  /** Trial mode: on when it runs each caller request on its `arms` (the agent's model first) at once. */
  readonly trial: { readonly on: boolean; readonly arms: ReadonlyArray<string> }
  readonly runs: RunStats
  /** Why the agent file's current text does not load (the last good version, if any, stays in force). */
  readonly error?: string
}

const HOUR_MILLIS = 3_600_000

/** Every agent in load order, disabled ones too, then each agent file that failed to load and has no version in force, with its run stats. */
export const roster = Effect.gen(function*() {
  const path = yield* Path.Path
  const settings = yield* (yield* Settings).current
  const loader = yield* Agents
  const agents = yield* loader.current
  const rejected = yield* loader.rejected
  const history = yield* (yield* EventBus).history
  const now = DateTime.toEpochMillis(yield* DateTime.now)

  // Every job run by component and run id: when it first started, and how it ended.
  const started = new Map<string, { readonly component: string; readonly at: string; ended?: "succeeded" | "failed" }>()
  for (const event of history) {
    if (event.component === RUNTIME) continue
    const phase = lifecycle(event)
    if (Option.isNone(phase)) continue
    const key = `${event.component} ${event.run}`
    const run = started.get(key)
    if (phase.value._tag === "job.started") {
      if (run === undefined) started.set(key, { component: event.component, at: event.at })
    } else if (run !== undefined) run.ended = phase.value._tag === "job.failed" ? "failed" : "succeeded"
  }
  const stats = new Map<string, { week: number; failed: number; running: number; lastAt?: string; last: number }>()
  for (const run of started.values()) {
    const at = Date.parse(run.at)
    const entry = stats.get(run.component) ?? { week: 0, failed: 0, running: 0, last: Number.NEGATIVE_INFINITY }
    stats.set(run.component, entry)
    if (now - at <= 7 * DAY_MILLIS) {
      entry.week += 1
      if (run.ended === "failed") entry.failed += 1
    }
    if (run.ended === undefined && now - at <= HOUR_MILLIS) entry.running += 1
    if (at > entry.last) {
      entry.last = at
      entry.lastAt = run.at
    }
  }
  const runsOf = (id: string): RunStats => {
    const { last: _last, ...entry } = stats.get(id) ?? { week: 0, failed: 0, running: 0, last: 0 }
    return entry
  }

  const errors = new Map(rejected.map(({ file, message }) => [file, message]))
  const loaded = agents.map((agent): RosterEntry => {
    const resolved = effective(agent, settings)
    const target = targetOf(agent)
    const mode = settings.components?.[agent.id]?.mode
    const error = agent.file === undefined ? undefined : errors.get(agent.file)
    return {
      id: agent.id,
      purpose: agent.purpose,
      kind: agent.kind,
      ...(agent.file === undefined ? {} : { file: agent.file }),
      knowledge: agent.knowledge,
      enabled: resolved.enabled,
      ...(mode === undefined ? {} : { mode }),
      model: resolved.agent.model,
      ...(resolved.fallbackModel === undefined ? {} : { fallbackModel: resolved.fallbackModel }),
      candidates: resolved.agent.candidates,
      ...(resolved.agent.thinking === undefined ? {} : { thinking: resolved.agent.thinking }),
      ...(target === undefined ? {} : { how: target.how, job: target.job.id }),
      trial: { on: resolved.trial.on, arms: resolved.trial.arms },
      runs: runsOf(agent.id),
      ...(error === undefined ? {} : { error })
    }
  })
  const files = new Set(agents.map((agent) => agent.file))
  const broken = rejected.filter(({ file }) => !files.has(file)).map(({ file, message }): RosterEntry => {
    const id = path.basename(file) === AGENT_DOC ? path.basename(path.dirname(file)) : path.basename(file).replace(/\.(json|ya?ml)$/, "")
    const own = settings.components?.[id]
    return {
      id,
      purpose: "",
      kind: "spec",
      file,
      knowledge: [],
      enabled: own?.enabled ?? true,
      ...(own?.mode === undefined ? {} : { mode: own.mode }),
      model: "",
      candidates: [],
      trial: { on: false, arms: [] },
      runs: runsOf(id),
      error: message
    }
  })
  return [...loaded, ...broken]
})
