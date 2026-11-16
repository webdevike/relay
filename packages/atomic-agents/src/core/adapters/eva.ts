import { Config, Effect, Path } from "effect"

/** Eva's checkout (`EVA_ROOT`, default `~/Eva`): the tools and logins some adapters wrap live there. */
export const EvaRoot = Effect.gen(function*() {
  const path = yield* Path.Path
  const home = yield* Config.String("HOME")
  return yield* Config.String("EVA_ROOT").pipe(Config.withDefault(path.join(home, "Eva")))
})
