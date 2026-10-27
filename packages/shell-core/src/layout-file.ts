import { PANEL_DEFAULT, PANEL_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from './fit'

export type PanelToolName = 'browser' | 'files'

/** layout.json keeps the panel choice of this many scopes, most recently set last. */
export const PANEL_CHOICES_MAX = 200

export interface LayoutRead {
  sidebarWidth: number
  panelWidth: number
  tabs: unknown | null
  /** Isaac's explicit panel open/close per browser scope, oldest first. */
  panelChoices: Record<string, boolean>
  panelTool: PanelToolName
  malformed: boolean
}

export interface LayoutPatch {
  sidebarWidth?: number
  panelWidth?: number
  tabs?: unknown
  /** Upserts per scope (moved to the most recent end); null forgets the scope. */
  panelChoices?: Record<string, boolean | null>
  panelTool?: PanelToolName
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max)

const sidebarClamp = (n: number) => clamp(n, SIDEBAR_MIN, SIDEBAR_MAX)
const panelClamp = (n: number) => Math.max(n, PANEL_MIN)

const isTool = (v: unknown): v is PanelToolName => v === 'browser' || v === 'files'

/** The boolean entries of a stored choices object, capped to the most recent ones. */
function readChoices(v: unknown): Record<string, boolean> {
  if (!isObject(v)) return {}
  const entries = Object.entries(v).filter((e): e is [string, boolean] => typeof e[1] === 'boolean')
  return Object.fromEntries(entries.slice(-PANEL_CHOICES_MAX))
}

/** Parses layout.json text. null means the file is missing. Never throws. */
export function readLayoutText(text: string | null): LayoutRead {
  const defaults: LayoutRead = {
    sidebarWidth: SIDEBAR_DEFAULT,
    panelWidth: PANEL_DEFAULT,
    tabs: null,
    panelChoices: {},
    panelTool: 'browser',
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
  const pw = body['panel_width']
  const tool = body['panel_tool']
  return {
    sidebarWidth:
      typeof sw === 'number' && Number.isFinite(sw) ? sidebarClamp(sw) : SIDEBAR_DEFAULT,
    panelWidth: typeof pw === 'number' && Number.isFinite(pw) ? panelClamp(pw) : PANEL_DEFAULT,
    tabs: body['tabs'] ?? null,
    panelChoices: readChoices(body['panel_choices']),
    panelTool: isTool(tool) ? tool : 'browser',
    malformed: false,
  }
}

/** Applies a patch over the existing body, keeping every other key verbatim. */
export function mergeLayout(existing: unknown, patch: LayoutPatch): Record<string, unknown> {
  const out: Record<string, unknown> = isObject(existing) ? { ...existing } : {}
  if (patch.sidebarWidth !== undefined && Number.isFinite(patch.sidebarWidth)) {
    out['sidebar_width'] = Math.round(sidebarClamp(patch.sidebarWidth))
  }
  if (patch.panelWidth !== undefined && Number.isFinite(patch.panelWidth)) {
    out['panel_width'] = Math.round(panelClamp(patch.panelWidth))
  }
  if ('tabs' in patch) out['tabs'] = patch.tabs
  if (patch.panelChoices !== undefined) {
    const choices = new Map(Object.entries(readChoices(out['panel_choices'])))
    for (const [scope, open] of Object.entries(patch.panelChoices)) {
      choices.delete(scope)
      if (typeof open === 'boolean') choices.set(scope, open)
    }
    out['panel_choices'] = Object.fromEntries([...choices].slice(-PANEL_CHOICES_MAX))
  }
  if (isTool(patch.panelTool)) out['panel_tool'] = patch.panelTool
  return out
}

export function serializeLayout(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n'
}
