import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer } from "effect"
import { Components, type Registered } from "../src/Component.ts"
import { EventBus, Home } from "../src/Event.ts"
import { ModelRunner } from "../src/Model.ts"
import { Runner } from "../src/Runtime.ts"
import { Settings } from "../src/Settings.ts"

const homeAt = (root: string) =>
  Layer.succeed(Home, Home.of({
    root,
    journal: `${root}/events.ndjson`,
    runDir: (component, run) => `${root}/runs/${component}/${run}`,
    stateDir: (component) => `${root}/state/${component}`
  }))

/** Settings and EventBus over `root`: what one process (the service, or a CLI command) builds. */
export const oneProcess = (root: string, components: ReadonlyArray<Registered>) =>
  Settings.layer.pipe(
    Layer.provideMerge(EventBus.layer),
    Layer.provideMerge(homeAt(root)),
    Layer.provideMerge(Layer.succeed(Components, components)),
    Layer.provideMerge(BunServices.layer)
  )

export const runtime = (
  root: string,
  components: ReadonlyArray<Registered>,
  models: ModelRunner["Service"] = ModelRunner.of({ generate: () => Effect.die("no model calls in tests") })
) =>
  Runner.layer.pipe(
    Layer.provideMerge(Layer.succeed(ModelRunner, models)),
    Layer.provideMerge(oneProcess(root, components))
  )

export const tempHome = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "atomic-agents-test-" })
}).pipe(Effect.provide(BunServices.layer))
