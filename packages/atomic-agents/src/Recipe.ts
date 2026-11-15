import { Clock, Cron, DateTime, Effect, Layer, Option, Result, Schema } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import type { AdapterContext, CheckAdapter, ModelAdapter, Registry, SourceAdapter, StepAdapter, ToolAdapter } from "./Adapter.ts"
import { define, type EventSchemas, type Failure, job, type JobContext, type Registered, Trigger } from "./Component.ts"
import { compileFields, type Fields } from "./Fields.ts"
import { type GenerateRequest, generateWithTools, ModelRunner, tool } from "./Model.ts"

/**
 * The standard recipe, as a chef file writes it (`chefs/<id>.json`):
 *
 *     trigger -> [source] -> [steps] -> model (+ allowed tools, step cap) -> [check (+1 repair)] -> emit output
 *
 * A source turns the input into items (gmail: new messages); each item goes through the steps, one
 * model turn and the check, then becomes one output event. Everything named is an adapter (`Adapter.ts`).
 */
const Thinking = Schema.Literals(["off", "minimal", "low", "medium", "high"])
const Lines = Schema.Union([Schema.String, Schema.Array(Schema.String)])
const Shape = Schema.Record(Schema.String, Schema.Json)

const TriggerSpec = Schema.Union([
  Schema.Literal("manual"),
  Schema.Struct({
    cron: Schema.NonEmptyString,
    /** The job input each time (default `{}`). */
    input: Schema.optionalKey(Schema.Json),
    /** Or one of these, rotating by UTC day. */
    inputs: Schema.optionalKey(Schema.Array(Schema.Json))
  }),
  /** A declared event of this chef (`widget.requested`), or another component's full type (`gmail/message.triaged`). */
  Schema.Struct({ onEvent: Schema.NonEmptyString })
])

export const RecipeFile = Schema.Struct({
  id: Schema.String,
  kind: Schema.optionalKey(Schema.Literal("recipe")),
  /** One sentence. If it needs two, it is two chefs. */
  purpose: Schema.NonEmptyString,
  agent: Schema.Struct({
    /** Model adapter, default `omp`. */
    adapter: Schema.optionalKey(Schema.NonEmptyString),
    model: Schema.NonEmptyString,
    candidates: Schema.Array(Schema.NonEmptyString),
    thinking: Schema.optionalKey(Thinking),
    /** The system prompt (a list is joined with newlines); `{{check}}` places the check adapter's contract. */
    system: Lines,
    /** Files appended to the system prompt on every run (relative to this file; `~` and `${VAR:-default}` expand). */
    knowledge: Schema.optionalKey(Schema.Array(Schema.Struct({ file: Schema.NonEmptyString, heading: Schema.optionalKey(Schema.NonEmptyString) })))
  }),
  /** Event name → its fields (`Fields.ts`). The chef's whole output contract. */
  events: Schema.Record(Schema.String, Shape),
  job: Schema.Struct({
    id: Schema.NonEmptyString,
    description: Schema.NonEmptyString,
    /** A declared event name (its data is the input) or the input's fields. */
    input: Schema.Union([Schema.NonEmptyString, Shape]),
    triggers: Schema.Array(TriggerSpec),
    source: Schema.optionalKey(Schema.NonEmptyString),
    steps: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    /** The model's prompt per item; `{{field}}` inserts an input, source or step field. */
    prompt: Lines,
    /** Fields holding image paths (one path or a list) the model sees with the prompt (vision models), repair turn included. */
    attach: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    /** Seconds per model call (default 300). */
    timeout: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
    tools: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    /** The model answers this JSON object (needed for tools); its fields go into the output. */
    answer: Schema.optionalKey(Shape),
    answerExample: Schema.optionalKey(Schema.NonEmptyString),
    /** Model calls per item in the tool loop, the answer included (default 3). */
    maxSteps: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    check: Schema.optionalKey(Schema.NonEmptyString),
    /** The event each item becomes. */
    output: Schema.NonEmptyString,
    /** An event emitted once per run after every item: the source's summary fields plus `modelCalls` and `cost`. */
    summary: Schema.optionalKey(Schema.NonEmptyString),
    /** When an item fails, emit the output with these fields first (`{{message}}` is the error), then fail the run. */
    onFailure: Schema.optionalKey(Shape)
  }),
  /** The request/reply pair callers `ask`; `show` is the reply field `atomic-agents ask` prints (else `none`). */
  asks: Schema.optionalKey(Schema.Struct({ request: Schema.NonEmptyString, reply: Schema.NonEmptyString, show: Schema.NonEmptyString }))
})
export type RecipeFile = typeof RecipeFile.Type

/** What compiling a recipe needs from its loader: the adapters, and knowledge paths already resolved. */
export interface RecipeEnv {
  readonly adapters: Registry
  /** `agent.knowledge` with absolute paths, checked to exist. */
  readonly knowledge: ReadonlyArray<{ readonly file: string; readonly heading?: string }>
  readonly readFile: (file: string) => Effect.Effect<string, Failure>
}

/** Stats every item's output may use: the model in force, model calls, USD, seconds. */
const ITEM_STATS = ["model", "attempts", "cost", "seconds"]
const SUMMARY_STATS = ["modelCalls", "cost"]
const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g

const join = (lines: string | ReadonlyArray<string>) => typeof lines === "string" ? lines : lines.join("\n")

/** The `{{name}}` fields a template reads. */
export const placeholders = (text: string) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!)

/** `{{field}}` → the field (strings as is, anything else as JSON; absent → empty). */
export const render = (template: string, fields: Readonly<Record<string, unknown>>) =>
  template.replace(PLACEHOLDER, (_, name: string) => {
    const value = fields[name]
    return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)
  })

const renderShape = (shape: Readonly<Record<string, Schema.Json>>, fields: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, typeof value === "string" ? render(value, fields) : value]))

const lookup = <A>(adapters: ReadonlyMap<string, A>, kind: string, name: string, errors: Array<string>): A | undefined => {
  const found = adapters.get(name)
  if (found === undefined) errors.push(`unknown ${kind} adapter ${JSON.stringify(name)} (have: ${[...adapters.keys()].join(", ") || "none"})`)
  return found
}

const shortName = (name: string) => name.slice(name.lastIndexOf(".") + 1)

/** What one item yields: its output fields plus what it took. */
export interface ItemResult {
  readonly fields: Readonly<Record<string, unknown>>
  /** Model calls, tool turns and the repair included. */
  readonly attempts: number
  readonly cost: number
  readonly seconds: number
}

/** The compiled model stage of a recipe: what the bench calls directly, without bus or journal. */
export interface Cook {
  readonly system: string
  /** Steps, then the model turn and the check, for one item. */
  item(fields: Readonly<Record<string, unknown>>, context: AdapterContext): Effect.Effect<ItemResult, Failure, ModelRunner | BunServices>
}

export class RecipeError extends Schema.TaggedError<RecipeError>()("RecipeError", { message: Schema.String }) {}

/** A recipe chef file → a registered component, or every reason it is not one. */
export const compileRecipe = (file: RecipeFile, env: RecipeEnv): Result.Result<{ readonly chef: Registered; readonly cook: Cook }, ReadonlyArray<string>> => {
  const errors: Array<string> = []
  const { adapters } = env
  const spec = file.job

  const compiled = new Map<string, Fields>()
  for (const [name, shape] of Object.entries(file.events)) {
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(name)) errors.push(`events.${name}: event names are dotted lowercase (widget.ready)`)
    const result = compileFields(shape, `events.${name}`)
    if (result.ok) compiled.set(name, result.fields)
    else errors.push(...result.errors)
  }
  const events: EventSchemas = Object.fromEntries([...compiled].map(([name, fields]) => [name, fields.schema]))
  const declared = (name: string, at: string) => {
    const found = compiled.get(name)
    if (found === undefined && !errors.some((error) => error.startsWith(`events.${name}`))) {
      errors.push(`${at}: ${JSON.stringify(name)} is not a declared event (have: ${[...compiled.keys()].join(", ")})`)
    }
    return found
  }

  const input = typeof spec.input === "string"
    ? declared(spec.input, "job.input")
    : (() => {
      const result = compileFields(spec.input, "job.input")
      if (!result.ok) errors.push(...result.errors)
      return result.ok ? result.fields : undefined
    })()

  const triggers = spec.triggers.flatMap((trigger, index): ReadonlyArray<Trigger> => {
    const at = `job.triggers[${index}]`
    if (trigger === "manual") return [Trigger.Manual()]
    if ("onEvent" in trigger) {
      if (trigger.onEvent.includes("/")) return [Trigger.OnEvent({ type: trigger.onEvent })]
      return declared(trigger.onEvent, at) === undefined ? [] : [Trigger.OnEvent({ type: `${file.id}/${trigger.onEvent}` })]
    }
    if (Result.isFailure(Cron.parse(trigger.cron))) errors.push(`${at}: bad cron ${JSON.stringify(trigger.cron)}`)
    if (trigger.input !== undefined && trigger.inputs !== undefined) errors.push(`${at}: input or inputs, not both`)
    if (trigger.inputs !== undefined && trigger.inputs.length === 0) errors.push(`${at}: inputs is empty`)
    const rotation = trigger.inputs
    return [Trigger.Cron({
      cron: trigger.cron,
      input: rotation === undefined
        ? Effect.succeed(trigger.input ?? {})
        : Effect.map(DateTime.now, (now) => rotation[Math.floor(DateTime.toEpochMillis(now) / 86_400_000) % rotation.length])
    })]
  })
  if (triggers.length === 0 && spec.triggers.length === 0) errors.push("job.triggers: at least one (\"manual\", {\"cron\"}, {\"onEvent\"})")

  const model: ModelAdapter | undefined = lookup(adapters.models, "model", file.agent.adapter ?? "omp", errors)
  const source: SourceAdapter | undefined = spec.source === undefined ? undefined : lookup(adapters.sources, "source", spec.source, errors)
  const steps = (spec.steps ?? []).flatMap((name): ReadonlyArray<StepAdapter> => Option.toArray(Option.fromUndefinedOr(lookup(adapters.steps, "step", name, errors))))
  const tools = (spec.tools ?? []).flatMap((name): ReadonlyArray<ToolAdapter> => Option.toArray(Option.fromUndefinedOr(lookup(adapters.tools, "tool", name, errors))))
  const check: CheckAdapter | undefined = spec.check === undefined ? undefined : lookup(adapters.checks, "check", spec.check, errors)

  const seen = new Set<string>()
  for (const candidate of tools) {
    if (seen.has(shortName(candidate.name))) errors.push(`job.tools: two tools the model would call ${shortName(candidate.name)}`)
    seen.add(shortName(candidate.name))
  }

  const answer = spec.answer === undefined ? undefined : (() => {
    const result = compileFields(spec.answer, "job.answer")
    if (!result.ok) errors.push(...result.errors)
    return result.ok ? result.fields : undefined
  })()
  if (tools.length > 0 && spec.answer === undefined) errors.push("job.tools: a tool loop needs job.answer (the JSON the model answers with)")
  if (spec.maxSteps !== undefined && spec.answer === undefined) errors.push("job.maxSteps: only applies with job.answer")

  // Which fields exist where: the prompt reads input, source and step fields; the output adds the answer, check and stats.
  const before = new Set([...(input?.fields.keys() ?? []), ...(source?.provides ?? []), ...steps.flatMap((step) => step.provides)])
  for (const name of placeholders(join(spec.prompt))) {
    if (!before.has(name)) errors.push(`job.prompt: {{${name}}} is not an input, source or step field (have: ${[...before].join(", ")})`)
  }
  for (const name of spec.attach ?? []) {
    if (!before.has(name)) errors.push(`job.attach: ${name} is not an input, source or step field (have: ${[...before].join(", ")})`)
  }
  const after = new Set([...before, ...ITEM_STATS, ...(answer?.fields.keys() ?? []), ...(check?.provides ?? []), ...(!answer && !check ? ["text"] : [])])
  const output = declared(spec.output, "job.output")
  const missing = (target: Fields | undefined, have: ReadonlySet<string>) =>
    [...(target?.fields ?? [])].flatMap(([name, { required }]) => required && !have.has(name) ? [name] : [])
  const lost = missing(output, after)
  if (lost.length > 0) errors.push(`job.output: nothing provides ${spec.output}'s required ${lost.join(", ")} (have: ${[...after].join(", ")})`)
  if (spec.onFailure !== undefined) {
    const onFailure = new Set([...before, "model", ...Object.keys(spec.onFailure)])
    const short = missing(output, onFailure)
    if (short.length > 0) errors.push(`job.onFailure: ${spec.output} would still lack ${short.join(", ")}`)
  }
  if (spec.summary !== undefined) {
    const summary = declared(spec.summary, "job.summary")
    const short = missing(summary, new Set([...(source?.summary ?? []), ...SUMMARY_STATS]))
    if (short.length > 0) errors.push(`job.summary: nothing provides ${spec.summary}'s required ${short.join(", ")}`)
  }

  const rawSystem = join(file.agent.system)
  for (const name of placeholders(rawSystem)) {
    if (name !== "check") errors.push(`agent.system: unknown placeholder {{${name}}} (only {{check}})`)
    else if (check?.contract === undefined) errors.push(`agent.system: {{check}} needs a check adapter with a contract${check ? ` (${check.name} has none)` : ""}`)
  }
  const system = rawSystem.replace(PLACEHOLDER, () => check?.contract ?? "")

  if (file.asks !== undefined) {
    const request = declared(file.asks.request, "asks.request")
    const reply = declared(file.asks.reply, "asks.reply")
    for (const [name, fields] of [[file.asks.request, request], [file.asks.reply, reply]] as const) {
      if (fields !== undefined && !fields.fields.has("requestId")) errors.push(`asks: ${name} must declare requestId`)
    }
    if (reply !== undefined && !reply.fields.has(file.asks.show)) errors.push(`asks.show: ${file.asks.reply} has no field ${file.asks.show}`)
  }

  if (errors.length > 0 || input === undefined || output === undefined || model === undefined) return Result.fail(errors)

  const prompt = join(spec.prompt)
  const timeout = spec.timeout === undefined ? undefined : `${spec.timeout} seconds` as const
  const loopTools = tools.map((candidate) =>
    tool({ name: shortName(candidate.name), description: candidate.description, args: candidate.args, example: candidate.example, run: candidate.run }))
  const answerExample = spec.answerExample ?? JSON.stringify(Object.fromEntries([...(answer?.fields.keys() ?? [])].map((name) => [name, `<${name}>`])))

  const withKnowledge = Effect.gen(function*() {
    if (env.knowledge.length === 0) return system
    const parts = yield* Effect.forEach(env.knowledge, ({ file: path, heading }) =>
      Effect.map(env.readFile(path), (text) => `\n\n${heading === undefined ? "" : `## ${heading}\n`}${text.trim()}`))
    return `${system}${parts.join("")}`
  })

  /** The attached fields' paths: a missing field attaches nothing, anything but a path or a list of paths fails the item. */
  const attached = (fields: Readonly<Record<string, unknown>>) =>
    Effect.forEach(spec.attach ?? [], (name) => {
      const value = fields[name]
      const paths = value === undefined ? [] : Array.isArray(value) ? value : [value]
      return paths.every((entry): entry is string => typeof entry === "string" && entry !== "")
        ? Effect.succeed(paths as ReadonlyArray<string>)
        : Effect.fail(new RecipeError({ message: `job.attach: ${name} is not a path or a list of paths` }))
    }).pipe(Effect.map((lists) => lists.flat()))

  const item = Effect.fn("Recipe.item")(function*(raw: Readonly<Record<string, unknown>>, context: AdapterContext, agentSystem?: string) {
    const started = yield* Clock.currentTimeMillis
    let fields = raw
    for (const step of steps) fields = { ...fields, ...(yield* step.run(fields, context)) }
    const files = yield* attached(fields)
    const services = yield* Effect.context<ModelRunner | BunServices>()
    const viaAdapter = ModelRunner.of({ generate: (request) => model.generate(request).pipe(Effect.provideContext(services)) })
    const request: Omit<GenerateRequest, "prompt"> = {
      model: context.model,
      system: agentSystem ?? (yield* withKnowledge),
      ...(files.length === 0 ? {} : { files }),
      ...(context.agent.thinking ? { thinking: context.agent.thinking } : {}),
      ...(timeout === undefined ? {} : { timeout })
    }
    const call = (text: string) =>
      (answer === undefined
        ? Effect.map(viaAdapter.generate({ ...request, prompt: text }), (reply) => ({ text: reply.text, answer: undefined as unknown, calls: 1, cost: reply.cost }))
        : Effect.map(
          generateWithTools({ ...request, prompt: text }, { tools: loopTools, answer: answer.schema, answerExample, maxSteps: spec.maxSteps ?? 3 }),
          (reply) => ({ text: JSON.stringify(reply.answer), answer: reply.answer, calls: reply.steps, cost: reply.cost })
        )).pipe(Effect.provideService(ModelRunner, viaAdapter))
    const first = yield* call(render(prompt, fields))
    const done = (out: Readonly<Record<string, unknown>>, attempts: number, cost: number) =>
      Effect.map(Clock.currentTimeMillis, (now): ItemResult => ({ fields: out, attempts, cost, seconds: (now - started) / 1000 }))
    if (check === undefined) return yield* done(answer === undefined ? { text: first.text } : (first.answer as Record<string, unknown>), first.calls, first.cost)
    const base = { ...context, prompt: render(prompt, fields), fields }
    // A passing check's fields go over the answer's: the check may annotate or replace answer fields.
    const passed = (reply: { readonly answer: unknown }, out: Readonly<Record<string, unknown>>) =>
      answer === undefined ? out : { ...(reply.answer as Record<string, unknown>), ...out }
    const verdict = yield* check.check({ text: first.text, answer: first.answer }, { ...base, attempt: 1 })
    if (verdict.pass) return yield* done(passed(first, verdict.fields), first.calls, first.cost)
    // The one repair turn: the check says what failed.
    const second = yield* call(verdict.repair)
    const retry = yield* check.check({ text: second.text, answer: second.answer }, { ...base, attempt: 2 })
    return yield* done(retry.pass ? passed(second, retry.fields) : yield* retry.giveUp, first.calls + second.calls, first.cost + second.cost)
  })

  const run = (decoded: unknown, ctx: JobContext<EventSchemas>) =>
    Effect.gen(function*() {
      const input = decoded as Readonly<Record<string, unknown>>
      const { emit, ...context } = ctx
      const agentSystem = yield* withKnowledge
      const batch = source === undefined
        ? { items: [{ fields: {}, commit: Effect.void }], done: Effect.void, summary: {} }
        : yield* source.fetch(input, context)
      let modelCalls = 0
      let cost = 0
      // Items in order, each one's output in the journal before the next starts: a failure resumes at it.
      for (const entry of batch.items) {
        const fields = { ...input, ...entry.fields }
        const result = yield* item(fields, context, agentSystem).pipe(
          Effect.tapError((error) =>
            spec.onFailure === undefined
              ? Effect.void
              : emit(spec.output, { model: ctx.model, ...fields, ...renderShape(spec.onFailure, { message: error.message }) }))
        )
        modelCalls += result.attempts
        cost += result.cost
        yield* emit(spec.output, { model: ctx.model, attempts: result.attempts, cost: result.cost, seconds: result.seconds, ...fields, ...result.fields })
        yield* entry.commit
      }
      yield* batch.done
      if (spec.summary !== undefined) yield* emit(spec.summary, { ...batch.summary, modelCalls, cost })
    })

  const recipeJob = job<EventSchemas, Schema.Codec<unknown>, BunServices>(events, {
    id: spec.id,
    description: spec.description,
    input: input.schema,
    triggers,
    run
  })

  const show = file.asks?.show
  const decodeReply = file.asks === undefined ? undefined : Schema.decodeUnknownOption(compiled.get(file.asks.reply)!.schema)
  const chef = define({
    id: file.id,
    purpose: file.purpose,
    agent: { model: file.agent.model, candidates: file.agent.candidates, ...(file.agent.thinking ? { thinking: file.agent.thinking } : {}), system },
    events,
    jobs: [recipeJob],
    tools: Layer.empty,
    ...(file.asks === undefined || decodeReply === undefined || show === undefined ? {} : {
      asks: {
        request: file.asks.request,
        reply: file.asks.reply,
        show: (reply: unknown) =>
          Option.match(decodeReply(reply), {
            onNone: () => "none",
            onSome: (data) => {
              const value = (data as Record<string, unknown>)[show]
              return typeof value === "string" ? value : "none"
            }
          })
      }
    })
  })
  return Result.succeed({ chef, cook: { system, item: (fields, context) => item(fields, context) } })
}
