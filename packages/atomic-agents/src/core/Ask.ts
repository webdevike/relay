import { type Duration, Effect, Option, Schema, Stream } from "effect"
import { type Contract, eventType } from "./Component.ts"
import { EventBus, makeEvent } from "./Event.ts"
import { uuid } from "./Id.ts"

/**
 * A request/response pair a component answers. A caller emits `request` with a fresh `requestId`; the
 * component's job (an `OnEvent` trigger on `request`) emits `reply` with the same `requestId`. Both
 * event schemas declare `requestId`.
 */
export interface Asks {
  readonly request: string
  readonly reply: string
  /** The reply's data as one text for `atomic-agents ask` (the widget block, or `none`). */
  show(reply: unknown): string
}

export class AskTimeout extends Schema.TaggedError<AskTimeout>()("AskTimeout", {
  request: Schema.String,
  requestId: Schema.String,
  message: Schema.String
}) {}

/** Every request and reply carries the correlation id; the rest of the data is the pair's own. */
const decodeCorrelated = Schema.decodeUnknownOption(Schema.Struct({ requestId: Schema.String }))

/**
 * Append `request` of `contract` with `data` plus a fresh `requestId`; answers that id. `data` must match the
 * request schema (a `SchemaError` otherwise). The caller listens for the reply first if it waits (`ask`, `Requests.ts`).
 */
export const publishRequest = Effect.fn("publishRequest")(function*(
  contract: Contract,
  pair: Pick<Asks, "request" | "reply">,
  data: Readonly<Record<string, unknown>>
) {
  const bus = yield* EventBus
  const schema = contract.events[pair.request]
  if (schema === undefined || contract.events[pair.reply] === undefined) {
    return yield* Effect.die(new Error(`${contract.id} does not declare ${pair.request} and ${pair.reply}`))
  }
  const requestId = yield* uuid
  const encoded = yield* Schema.encodeUnknownEffect(schema)({ ...data, requestId })
  yield* bus.publish(yield* makeEvent({
    type: eventType(contract, pair.request),
    component: contract.id,
    job: "ask",
    run: `ask-${requestId.slice(0, 8)}`,
    data: encoded
  }))
  return requestId
})

/**
 * Emit `request` of `contract` with `data` plus a fresh `requestId` and wait up to `timeout` for the `reply`
 * carrying that id. It listens before it publishes, so a fast reply cannot slip past. Answers the reply's
 * data as written in the journal (encoded); decode it with the reply's schema.
 */
export const ask = Effect.fn("ask")(function*(
  contract: Contract,
  pair: Pick<Asks, "request" | "reply">,
  data: Readonly<Record<string, unknown>>,
  timeout: Duration.Input
) {
  const bus = yield* EventBus
  const replyType = eventType(contract, pair.reply)
  const replies = yield* bus.listen
  const requestId = yield* publishRequest(contract, pair, data)
  const reply = yield* replies.pipe(
    Stream.filter((event) => event.type === replyType && Option.exists(decodeCorrelated(event.data), (reply) => reply.requestId === requestId)),
    Stream.runHead,
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(new AskTimeout({ request: pair.request, requestId, message: `no ${replyType} for ${requestId} within ${timeout}` }))
    })
  )
  // The stream only ends when the bus shuts down, which cannot happen inside this scope.
  if (Option.isNone(reply)) return yield* Effect.die(new Error("event bus closed while asking"))
  return { requestId, data: reply.value.data }
}, Effect.scoped)
