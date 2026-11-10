import { isToolKind, type ToolKind } from './dock'
import { PANEL_DEFAULT, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from './fit'

/** What the side panel was before panes: read once to seed the first layout. */
export interface LegacyPanel {
  width: number
  tool: ToolKind
}

export interface LayoutRead {
  sidebarWidth: number
  tabs: unknown | null
  /** The saved dockview layout (shell-core reconcileDock reads it); null when there is none yet. */
  dock: Record<string, unknown> | null
  /** The split tree kept before dockview, while no `dock` is saved: migrated once (migrateTiling). */
  tiling: Record<string, unknown> | null
  /** Each workspace's own layout and the pinned tool tabs (workspace.ts readWorkspaces). */
  workspaces: Record<string, unknown> | null
  /** The old panel's width and tool, while neither layout is saved. */
  legacyPanel: LegacyPanel | null
  /** The sidebar customization (shown/hidden items, order, favorites); the renderer validates it. */
  sidebar: Record<string, unknown> | null
  /** Small per-key UI choices (filters, sort, folds, panel widths): `ui-prefs.ts` in the renderer. */
  ui: Record<string, unknown> | null
  malformed: boolean
}

export interface LayoutPatch {
  sidebarWidth?: number
  tabs?: unknown
  /** The dockview layout (its toJSON). */
  dock?: Record<string, unknown>
  /** The workspaces record (workspace.ts saveWorkspaces), replaced whole. */
  workspaces?: Record<string, unknown>
  /** The sidebar customization, replaced whole. */
  sidebar?: Record<string, unknown>
  /** UI choices merged key by key; a null value deletes the key. */
  ui?: Record<string, unknown>
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const sidebarClamp = (n: number) => Math.min(Math.max(n, SIDEBAR_MIN), SIDEBAR_MAX)

/** Parses layout.json text. null means the file is missing. Never throws. */
export function readLayoutText(text: string | null): LayoutRead {
  const defaults: LayoutRead = {
    sidebarWidth: SIDEBAR_DEFAULT,
    tabs: null,
    dock: null,
    workspaces: null,
    tiling: null,
    legacyPanel: null,
    sidebar: null,
    ui: null,
    malformed: false,
  }
  if (text === null) return defaults
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ...defaults, malformed: true }
  }
  if (!isObject(body)) return { ...defaults, malformed: true }
  const sw = body['sidebar_width']
  const dock = isObject(body['dock']) ? body['dock'] : null
  const tiling = dock === null && isObject(body['tiling']) ? body['tiling'] : null
  let legacyPanel: LegacyPanel | null = null
  if (dock === null && tiling === null) {
    const pw = body['panel_width']
    const tool = body['panel_tool']
    legacyPanel = {
      width: typeof pw === 'number' && Number.isFinite(pw) && pw > 0 ? pw : PANEL_DEFAULT,
      tool: isToolKind(tool) ? tool : 'files',
    }
  }
  return {
    sidebarWidth:
      typeof sw === 'number' && Number.isFinite(sw) ? sidebarClamp(sw) : SIDEBAR_DEFAULT,
    tabs: body['tabs'] ?? null,
    dock,
    workspaces: isObject(body['workspaces']) ? body['workspaces'] : null,
    tiling,
    legacyPanel,
    sidebar: isObject(body['sidebar']) ? body['sidebar'] : null,
    ui: isObject(body['ui']) ? body['ui'] : null,
    malformed: false,
  }
}

/**
 * Applies a patch over the existing body, keeping every other key verbatim. Saving the dockview
 * layout drops what it replaces: the split tree and the side panel's width, per-page choices and
 * tool.
 */
export function mergeLayout(existing: unknown, patch: LayoutPatch): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(existing) ? { ...existing } : {}
  if (patch.sidebarWidth !== undefined && Number.isFinite(patch.sidebarWidth)) {
    out['sidebar_width'] = Math.round(sidebarClamp(patch.sidebarWidth))
  }
  if ('tabs' in patch) out['tabs'] = patch.tabs
  if (patch.sidebar !== undefined) out['sidebar'] = patch.sidebar
  if (patch.ui !== undefined) {
    const ui: Record<string, unknown> = isObject(out['ui']) ? { ...out['ui'] } : {}
    for (const [k, v] of Object.entries(patch.ui)) {
      if (v === null) delete ui[k]
      else ui[k] = v
    }
    out['ui'] = ui
  }
  if (patch.workspaces !== undefined) out['workspaces'] = patch.workspaces
  if (patch.dock !== undefined) {
    out['dock'] = patch.dock
    delete out['tiling']
    delete out['panel_width']
    delete out['panel_choices']
    delete out['panel_tool']
  }
  return out
}

export function serializeLayout(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n'
}
