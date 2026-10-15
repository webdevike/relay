import { mergeLayout, readLayoutText, type LayoutPatch } from '@evaos/shell-core'
import type { ConfigStore } from './config-store'
import type { MainContext } from './context'
import { handle } from './ipc/handle'
import type { WriteQueue } from './write-queue'

const FILE = 'layout.json'

export function loadLayout(config: ConfigStore): {
  sidebarWidth: number
  panelWidth: number
  tabs: unknown
  reset: boolean
} {
  const r = readLayoutText(config.readText(FILE))
  return { sidebarWidth: r.sidebarWidth, panelWidth: r.panelWidth, tabs: r.tabs, reset: r.malformed }
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

export function registerLayoutIpc(ctx: MainContext, queue: WriteQueue): void {
  handle(ctx, 'layout.load', () => loadLayout(ctx.config))
  handle(ctx, 'layout.save', async (patch) => {
    await queue.enqueue(() => saveLayout(ctx.config, patch))
    return {}
  })
}
