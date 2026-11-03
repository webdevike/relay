import {
  mergeLayout,
  readLayoutText,
  tilingFromJson,
  tilingToJson,
  type LayoutPatch,
  type LegacyPanel,
} from '@evaos/shell-core'
import type { InvokeInput } from '@evaos/contract'
import type { ConfigStore } from './config-store'
import type { MainContext } from './context'
import { handle } from './ipc/handle'
import type { WriteQueue } from './write-queue'

const FILE = 'layout.json'

export function loadLayout(config: ConfigStore): {
  sidebarWidth: number
  tabs: unknown
  tiling: Record<string, unknown> | null
  legacyPanel: LegacyPanel | null
  reset: boolean
} {
  const r = readLayoutText(config.readText(FILE))
  return {
    sidebarWidth: r.sidebarWidth,
    tabs: r.tabs,
    tiling: r.tiling ? tilingToJson(r.tiling) : null,
    legacyPanel: r.legacyPanel,
    reset: r.malformed,
  }
}

export function saveLayout(config: ConfigStore, patch: LayoutPatch): void {
  let existing: unknown = {}
  try {
    const text = config.readText(FILE)
    if (text !== null) existing = JSON.parse(text)
  } catch {
    existing = {}
  }
  config.writeJson(FILE, mergeLayout(existing, patch))
}

/** The IPC patch with its tiling validated; a tree that does not read back is refused. */
function toPatch(input: InvokeInput<'layout.save'>): LayoutPatch {
  const { tiling, ...rest } = input
  if (tiling === undefined) return rest
  const parsed = tilingFromJson(tiling)
  if (!parsed) throw Object.assign(new Error('Not a pane tree'), { code: 'invalid-tiling' })
  return { ...rest, tiling: parsed }
}

export function registerLayoutIpc(ctx: MainContext, queue: WriteQueue): void {
  handle(ctx, 'layout.load', () => loadLayout(ctx.config))
  handle(ctx, 'layout.save', async (input) => {
    const patch = toPatch(input)
    await queue.enqueue(() => saveLayout(ctx.config, patch))
    return {}
  })
}
