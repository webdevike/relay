import { Layer, Schema } from "effect"
import { define, job, Trigger } from "../../src/core/Component.ts"

/** A code component a `kind: "code"` agent file points at (the escape hatch). */
const events = { "echo.done": Schema.Struct({ said: Schema.String }) }

export const echo = define({
  id: "echo",
  events,
  purpose: "Say back what it was given.",
  agent: { model: "test/code", candidates: ["test/code"], system: "" },
  jobs: [job(events, {
    id: "say",
    description: "Emit echo.done with the input.",
    input: Schema.Struct({ text: Schema.String }),
    triggers: [Trigger.Manual()],
    run: ({ text }, ctx) => ctx.emit("echo.done", { said: text })
  })],
  tools: Layer.empty
})
