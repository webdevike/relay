import { BunServices } from "@effect/platform-bun"
import { ConfigProvider, Effect, FileSystem, Layer } from "effect"
import { Adapters, type Pack } from "../src/core/Adapter.ts"
import { packs as defaultPacks } from "../src/packs.ts"
import { BUILTIN_AGENTS, Agents } from "../src/core/Agent.ts"
import type { Registered } from "../src/core/Component.ts"
import { EventBus, Home } from "../src/core/Event.ts"
import { ModelRunner } from "../src/core/Model.ts"
import { Runner } from "../src/core/Runtime.ts"
import { Settings } from "../src/core/Settings.ts"

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
  /** Agent dirs to load (default none). */
  readonly dirs?: ReadonlyArray<string>
  /** Adapter packs (default: the package's own). */
  readonly packs?: ReadonlyArray<Pack>
  /** Config values (EVA_ROOT, ...) over the process environment. */
  readonly env?: Readonly<Record<string, string>>
}

/** Settings, agents and EventBus over `root`: what one process (the service, or a CLI command) builds. */
export const oneProcess = (root: string, world: World = {}) =>
  Settings.layer.pipe(
    Layer.provideMerge(Agents.make({ dirs: () => world.dirs ?? [], code: world.code ?? [] })),
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

/** An agent dir under `root` holding these built-in agent files (and their knowledge files), as shipped. */
export const builtinAgents = (root: string, ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = `${root}/agents`
    yield* fs.makeDirectory(dir, { recursive: true })
    for (const builtin of BUILTIN_AGENTS) {
      for (const name of yield* fs.readDirectory(builtin)) {
        if (ids.some((id) => name.startsWith(`${id}.`))) yield* fs.copyFile(`${builtin}/${name}`, `${dir}/${name}`)
      }
    }
    return dir
  }).pipe(Effect.provide(BunServices.layer))

/** The agent in force with this id. */
export const agent = (id: string) =>
  Effect.gen(function*() {
    const found = (yield* (yield* Agents).current).find((candidate) => candidate.id === id)
    if (found === undefined) return yield* Effect.die(new Error(`no agent ${id} loaded`))
    return found
  })
