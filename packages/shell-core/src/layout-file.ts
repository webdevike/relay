import { PANEL_DEFAULT, PANEL_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from './fit'

export interface LayoutRead {
  sidebarWidth: number
  panelWidth: number
  tabs: unknown | null
  malformed: boolean
}

export interface LayoutPatch {
  sidebarWidth?: number
  panelWidth?: number
  tabs?: unknown
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max)

const sidebarClamp = (n: number) => clamp(n, SIDEBAR_MIN, SIDEBAR_MAX)
const panelClamp = (n: number) => Math.max(n, PANEL_MIN)

/** Parses layout.json text. null means the file is missing. Never throws. */
export function readLayoutText(text: string | null): LayoutRead {
  const defaults: LayoutRead = {
    sidebarWidth: SIDEBAR_DEFAULT,
    panelWidth: PANEL_DEFAULT,
    tabs: null,
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
  return {
    sidebarWidth:
      typeof sw === 'number' && Number.isFinite(sw) ? sidebarClamp(sw) : SIDEBAR_DEFAULT,
    panelWidth: typeof pw === 'number' && Number.isFinite(pw) ? panelClamp(pw) : PANEL_DEFAULT,
    tabs: body['tabs'] ?? null,
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
  return out
}

export function serializeLayout(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n'
}
