// Isaac's pins in the context popover, in the order he pinned them, in `context-pins.json` under
// the app's config dir. Invalid entries are dropped on read; writes go through the config queue.
import { pinId, PinRefSchema, type PinRef } from '@evaos/contract'
import type { ConfigStore } from '../config-store'
import type { WriteQueue } from '../write-queue'

export const PINS_FILE = 'context-pins.json'
/** More than this many pins stops being a glance. */
export const MAX_PINS = 12

export class PinStore {
  constructor(
    private readonly config: ConfigStore,
    private readonly queue: WriteQueue,
  ) {}

  list(): PinRef[] {
    const raw = this.config.readJson<unknown>(PINS_FILE, {})
    const pins = (raw as { pins?: unknown } | null)?.pins
    if (!Array.isArray(pins)) return []
    const out: PinRef[] = []
    const ids = new Set<string>()
    for (const p of pins) {
      const r = PinRefSchema.safeParse(p)
      if (!r.success || ids.has(pinId(r.data))) continue
      ids.add(pinId(r.data))
      out.push(r.data)
    }
    return out
  }

  /** Adds `ref` last; pinning something already pinned changes nothing. Full at MAX_PINS. */
  pin(ref: PinRef): Promise<PinRef[]> {
    return this.queue.enqueue(() => {
      const pins = this.list()
      if (pins.some((p) => pinId(p) === pinId(ref))) return pins
      if (pins.length >= MAX_PINS) {
        throw Object.assign(new Error(`Unpin something first: ${MAX_PINS} pins is the most.`), {
          code: 'too-many-pins',
        })
      }
      const next = [...pins, ref]
      this.write(next)
      return next
    })
  }

  unpin(id: string): Promise<PinRef[]> {
    return this.queue.enqueue(() => {
      const next = this.list().filter((p) => pinId(p) !== id)
      this.write(next)
      return next
    })
  }

  private write(pins: PinRef[]): void {
    const existing = this.config.readForMerge(PINS_FILE)
    this.config.writeJson(PINS_FILE, { ...existing, pins })
  }
}
