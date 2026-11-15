import { Effect, Layer, Schema } from "effect"
import { pack } from "../Adapter.ts"

const Request = Schema.Struct({
  draft: Schema.String,
  data: Schema.optionalKey(Schema.Json),
  surface: Schema.String,
  context: Schema.optionalKey(Schema.Struct({ channel: Schema.Literals(["text", "voice"]), askedForDetail: Schema.optionalKey(Schema.Boolean) }))
})
const decodeRequest = Schema.decodeUnknownEffect(Request)

class WidgetPromptError extends Schema.TaggedError<WidgetPromptError>()("WidgetPromptError", { message: Schema.String }) {}

/**
 * The widget chef's one code step: its prompt has lines that only appear when the request says how
 * Isaac asked, more than a `{{field}}` template does.
 */
export const widget = pack({
  name: "widget",
  layer: Layer.empty,
  steps: [{
    name: "widget.prompt",
    description: "Lay out a widget.requested as the model's prompt: surface, how Isaac asked (when known), the draft, its data as JSON.",
    provides: ["prompt"],
    run: (fields) =>
      decodeRequest(fields).pipe(
        Effect.mapError((error) => new WidgetPromptError({ message: error.message })),
        Effect.map(({ draft, data, surface, context }) => {
          const asked = context === undefined ? [] : [`Isaac asked ${context.channel === "voice" ? "on a call" : "in text"}${context.askedForDetail === true ? ", for detail" : ""}.`]
          return { prompt: [`Surface: ${surface}`, ...asked, "Draft reply:", draft, "Data:", data === undefined ? "(none)" : JSON.stringify(data, null, 1)].join("\n") }
        })
      )
  }]
})
