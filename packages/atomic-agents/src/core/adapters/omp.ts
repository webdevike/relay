import { Effect, Layer } from "effect"
import { pack } from "../Adapter.ts"
import { ModelRunner } from "../Model.ts"

/** The `omp` model adapter: one call through the process's `ModelRunner` (`omp -p`, no tools, no repo context). */
export const omp = pack({
  name: "omp",
  layer: Layer.empty,
  models: [{
    name: "omp",
    description: "One model call through omp (`omp -p --mode json`, no tools or repo context); omp owns auth and routing.",
    generate: (request) => Effect.gen(function*() { return yield* (yield* ModelRunner).generate(request) })
  }]
})
