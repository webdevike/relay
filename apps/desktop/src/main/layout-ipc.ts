import { mergeLayout, readLayoutText, type LayoutPatch, type LegacyPanel } from '@evaos/shell-core'
import type { InvokeInput } from '@evaos/contract'
import type { ConfigStore } from './config-store'
import type { MainContext } from './context'
import { handle } from './ipc/handle'
import type { WriteQueue } from './write-queue'

const FILE = 'layout.json'
/** A dockview layout of a few dozen tabs is a few KB; anything this big is not one. */
const DOCK_MAX_BYTES = 512 * 1024

export function loadLayout(config: ConfigStore): {
  sidebarWidth: number
  tabs: unknown
  dock: Record<string, unknown> | null
  tiling: Record<string, unknown> | null
  legacyPanel: LegacyPanel | null
  reset: boolean
} {
  const r = readLayoutText(config.readText(FILE))
  return {
    sidebarWidth: r.sidebarWidth,
    tabs: r.tabs,
    dock: r.dock,
    tiling: r.tiling,
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

/**
 * The IPC patch with its dockview layout checked for shape and size; the renderer reconciles a
 * saved layout against its tabs on load (shell-core reconcileDock), so main keeps it verbatim.
 */
function toPatch(input: InvokeInput<'layout.save'>): LayoutPatch {
  const { dock } = input
  if (dock === undefined) return input
  const grid = dock['grid']
  const ok =
    typeof grid === 'object' &&
    grid !== null &&
    typeof dock['panels'] === 'object' &&
    dock['panels'] !== null &&
    JSON.stringify(dock).length <= DOCK_MAX_BYTES
  if (!ok) throw Object.assign(new Error('Not a pane layout'), { code: 'invalid-dock' })
  return input
}

export function registerLayoutIpc(ctx: MainContext, queue: WriteQueue): void {
  handle(ctx, 'layout.load', () => loadLayout(ctx.config))
  handle(ctx, 'layout.save', async (input) => {
    const patch = toPatch(input)
    await queue.enqueue(() => saveLayout(ctx.config, patch))
    return {}
  })
}
