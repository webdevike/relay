import { Context, FiberSet, Layer } from "effect"
import type { JournalError } from "./Event.ts"

/**
 * The service's long-running loops (config watch, triggers), forked by background layers
 * (`Settings.layerWatch`, `Runner.layerTriggers`) into one set owned by the layer graph.
 * Each loop handles its recoverable errors itself; anything that escapes (a `JournalError`:
 * the journal cannot be written; a defect) is fatal. The host joins the set, so the first fatal
 * error ends `serve` and launchd's KeepAlive restarts a clean process.
 */
export class Background extends Context.Service<Background, FiberSet.FiberSet<unknown, JournalError>>()("atomic-agents/Background") {
  static readonly layer = Layer.effect(Background, FiberSet.make<unknown, JournalError>())
}
