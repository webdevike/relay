import { PANEL_DEFAULT, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from './fit'
import { isToolKind, tilingFromJson, tilingToJson, type Tiling, type ToolKind } from './tiling'

/** What the side panel was before tiling: read once to seed the first tiling. */
export interface LegacyPanel {
  width: number
  tool: ToolKind
}

export interface LayoutRead {
  sidebarWidth: number
  tabs: unknown | null
  /** The saved pane tree, validated; null when there is none yet. */
  tiling: Tiling | null
  /** The old panel's width and tool, while no tiling is saved. */
  legacyPanel: LegacyPanel | null
  malformed: boolean
}

export interface LayoutPatch {
  sidebarWidth?: number
  tabs?: unknown
  tiling?: Tiling
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const sidebarClamp = (n: number) => Math.min(Math.max(n, SIDEBAR_MIN), SIDEBAR_MAX)

/** Parses layout.json text. null means the file is missing. Never throws. */
export function readLayoutText(text: string | null): LayoutRead {
  const defaults: LayoutRead = {
    sidebarWidth: SIDEBAR_DEFAULT,
    tabs: null,
    tiling: null,
    legacyPanel: null,
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
  const tiling = tilingFromJson(body['tiling'])
  let legacyPanel: LegacyPanel | null = null
  if (!tiling) {
    const pw = body['panel_width']
    const tool = body['panel_tool']
    legacyPanel = {
      width: typeof pw === 'number' && Number.isFinite(pw) && pw > 0 ? pw : PANEL_DEFAULT,
      tool: isToolKind(tool) ? tool : 'browser',
    }
  }
  return {
    sidebarWidth:
      typeof sw === 'number' && Number.isFinite(sw) ? sidebarClamp(sw) : SIDEBAR_DEFAULT,
    tabs: body['tabs'] ?? null,
    tiling,
    legacyPanel,
    malformed: false,
  }
}

/**
 * Applies a patch over the existing body, keeping every other key verbatim. Saving a tiling
 * drops the side panel's per-page choices and tool, which it replaces.
 */
export function mergeLayout(existing: unknown, patch: LayoutPatch): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(existing) ? { ...existing } : {}
  if (patch.sidebarWidth !== undefined && Number.isFinite(patch.sidebarWidth)) {
    out['sidebar_width'] = Math.round(sidebarClamp(patch.sidebarWidth))
  }
  if ('tabs' in patch) out['tabs'] = patch.tabs
  if (patch.tiling !== undefined) {
    out['tiling'] = tilingToJson(patch.tiling)
    delete out['panel_choices']
    delete out['panel_tool']
  }
  return out
}

export function serializeLayout(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n'
}
