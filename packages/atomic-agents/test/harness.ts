import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { Adapters, type Pack } from "../src/Adapter.ts"
import { packs as defaultPacks } from "../src/adapters/index.ts"
import { BUILTIN_CHEFS, Chefs } from "../src/Chef.ts"
import type { Registered } from "../src/Component.ts"
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

export interface World {
  /** Components passed in as code. */
  readonly code?: ReadonlyArray<Registered>
  /** Chef dirs to load (default none). */
  readonly dirs?: ReadonlyArray<string>
  /** Adapter packs (default: the package's own). */
  readonly packs?: ReadonlyArray<Pack>
  /** Config values (EVA_ROOT, ...) over the process environment. */
  readonly env?: Readonly<Record<string, string>>
}

/** Settings, chefs and EventBus over `root`: what one process (the service, or a CLI command) builds. */
export const oneProcess = (root: string, world: World = {}) =>
  Settings.layer.pipe(
    Layer.provideMerge(Chefs.make({ dirs: () => world.dirs ?? [], code: world.code ?? [] })),
    Layer.provideMerge(Adapters.make(world.packs ?? defaultPacks)),
    Layer.provideMerge(EventBus.layer),
    Layer.provideMerge(homeAt(root)),
    Layer.provideMerge(BunServices.layer),
    Layer.provide(ConfigProvider.layerAdd(ConfigProvider.fromUnknown(world.env ?? {}), { asPrimary: true }))
  )

export const runtime = (
  root: string,
  world: World = {},
  models: ModelRunner["Service"] = ModelRunner.of({ generate: () => Effect.die("no model calls in tests") })
) =>
  Runner.layer.pipe(
    Layer.provideMerge(Layer.succeed(ModelRunner, models)),
    Layer.provideMerge(oneProcess(root, world))
  )

export const tempHome = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "atomic-agents-test-" })
}).pipe(Effect.provide(BunServices.layer))

/** A chef dir under `root` holding these built-in chef files (and their knowledge files), as shipped. */
export const builtinChefs = (root: string, ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = `${root}/chefs`
    yield* fs.makeDirectory(dir, { recursive: true })
    for (const name of yield* fs.readDirectory(BUILTIN_CHEFS)) {
      if (ids.some((id) => name.startsWith(`${id}.`))) yield* fs.copyFile(`${BUILTIN_CHEFS}/${name}`, `${dir}/${name}`)
    }
    return dir
  }).pipe(Effect.provide(BunServices.layer))

/** The chef in force with this id. */
export const chef = (id: string) =>
  Effect.gen(function*() {
    const found = (yield* (yield* Chefs).current).find((candidate) => candidate.id === id)
    if (found === undefined) return yield* Effect.die(new Error(`no chef ${id} loaded`))
    return found
  })
