import { Effect, Layer } from "effect"
import { pack } from "../Adapter.ts"
import { ModelRunner, ToolLoopError } from "../Model.ts"

/**
 * The `omp` model adapter: one call through the process's `ModelRunner` (`omp -p`, no tools, no repo context), and
 * native tool sessions through its `runTools` (`omp --mode rpc` with the tools as host tools).
 */
export const omp = pack({
  name: "omp",
  layer: Layer.empty,
  models: [{
    name: "omp",
    description: "One model call through omp (`omp -p --mode json`, no tools or repo context), or a native tool session (`omp --mode rpc`, host tools); omp owns auth and routing.",
    generate: (request) => Effect.gen(function*() { return yield* (yield* ModelRunner).generate(request) }),
    runTools: (session) => Effect.gen(function*() {
      const runner = yield* ModelRunner
      if (runner.runTools === undefined) return yield* new ToolLoopError({ model: session.model, steps: 0, message: "this process's model runner has no native tool sessions" })
      return yield* runner.runTools(session)
    })
  }]
})
