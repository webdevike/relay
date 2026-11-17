import { appTabOf, type DockJson, type DockNode, type DockOrientation } from './dock'
import { readWorkspaces, saveWorkspaces, type Workspaces } from './workspace'

/**
 * The window mirror (Relay Host `workspace.*`): what a Relay Desktop shows, as entries the host
 * keeps per key so every Mac shows the same. A Mac's own sizes never travel: a pane layout goes as
 * shares of its split (percent of its siblings), and each Mac lays it out in its own window.
 *
 * Keys: `tabs` (the app tabs and the one in front), `pinned` (tool tabs pinned everywhere),
 * `order` (workspaces, most recent first), `layout:<workspace>` (its panes), `page:<tab id>` (a web
 * page: its URL, title and workspace).
 */
export type Entries = Record<string, unknown>

export interface MirrorPage {
  url: string
  title: string
  /** The workspace whose panes hold it. */
  scope: string
}

export interface MirrorState {
  /** layout.json `tabs` (shell-core SavedTabs), null before there are any. */
  tabs: unknown
  /** layout.json `workspaces`, null before there is one. */
  workspaces: Workspaces | null
  /** Web pages by tab id. */
  pages: Record<string, MirrorPage>
}

const LAYOUT = 'layout:'
const PAGE = 'page:'

/** Shares are kept to this many parts of a split; finer than a Mac lays out, so they round-trip. */
const SHARE_PARTS = 1000

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** JSON with object keys sorted, so the same value always reads the same. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, value: unknown) =>
    isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value,
  )
}

export const sameValue = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b)

/**
 * `json` with no Mac's size in it: every node's size becomes its share of its split (parts of
 * SHARE_PARTS), the grid's box is SHARE_PARTS square, and panel titles (each Mac reads its own)
 * leave. `placeDock` lays it out again for a window.
 */
export function portableDock(json: DockJson): DockJson {
  const walk = (node: DockNode, share: number): DockNode => {
    if (node.type === 'leaf') return { ...node, size: share }
    const total = node.data.reduce((sum, c) => sum + Math.max(0, c.size), 0)
    const shares = node.data.map((c) =>
      total > 0
        ? Math.round((SHARE_PARTS * Math.max(0, c.size)) / total)
        : Math.round(SHARE_PARTS / node.data.length),
    )
    return { ...node, size: share, data: node.data.map((c, i) => walk(c, shares[i]!)) }
  }
  const panels: DockJson['panels'] = {}
  for (const [id, panel] of Object.entries(json.panels)) {
    const { title: _title, ...rest } = panel
    panels[id] = rest as DockJson['panels'][string]
  }
  return {
    ...json,
    grid: {
      ...json.grid,
      root: walk(json.grid.root, SHARE_PARTS),
      width: SHARE_PARTS,
      height: SHARE_PARTS,
    },
    panels,
  }
}

/**
 * `json` laid out in a `width` x `height` box: each split's children get its length along the
 * split by their shares (any sizes work: a portable layout's shares, or another window's px).
 */
export function placeDock(json: DockJson, box: { width: number; height: number }): DockJson {
  const along = (o: DockOrientation): number => (o === 'HORIZONTAL' ? box.width : box.height)
  const across = (o: DockOrientation): number => (o === 'HORIZONTAL' ? box.height : box.width)
  const flip = (o: DockOrientation): DockOrientation =>
    o === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL'
  /** `node` runs along `o` over `length` px; its own size (along its parent) is `size`. */
  const walk = (node: DockNode, o: DockOrientation, length: number, size: number): DockNode => {
    if (node.type === 'leaf') return { ...node, size }
    const total = node.data.reduce((sum, c) => sum + Math.max(0, c.size), 0)
    let used = 0
    const data = node.data.map((c, i) => {
      const last = i === node.data.length - 1
      const px = last
        ? length - used
        : Math.round(total > 0 ? (length * Math.max(0, c.size)) / total : length / node.data.length)
      used += px
      return walk(c, flip(o), size, px)
    })
    return { ...node, size, data }
  }
  const o = json.grid.orientation
  return {
    ...json,
    grid: {
      ...json.grid,
      root: walk(json.grid.root, o, along(o), across(o)),
      width: box.width,
      height: box.height,
    },
  }
}

/** A state's entries: what this Mac shows, as the host keeps it. */
export function toEntries(state: MirrorState): Entries {
  const out: Entries = {}
  if (state.tabs !== null && state.tabs !== undefined) out['tabs'] = state.tabs
  const w = state.workspaces
  if (w) {
    out['pinned'] = w.pinned
    out['order'] = w.order
    for (const [ws, json] of Object.entries(w.layouts)) out[LAYOUT + ws] = portableDock(json)
  }
  for (const [id, page] of Object.entries(state.pages)) out[PAGE + id] = page
  return out
}

const isPage = (v: unknown): v is MirrorPage =>
  isObject(v) &&
  typeof v['url'] === 'string' &&
  typeof v['title'] === 'string' &&
  typeof v['scope'] === 'string'

/**
 * The state `entries` hold. `front` is the workspace of the tab in front, which the desktop works
 * out itself (the tabs say which tab that is), so it is left null here.
 */
export function fromEntries(entries: Entries): MirrorState {
  const layouts: Record<string, unknown> = {}
  const pages: Record<string, MirrorPage> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (key.startsWith(LAYOUT)) layouts[key.slice(LAYOUT.length)] = value
    else if (key.startsWith(PAGE) && isPage(value)) pages[key.slice(PAGE.length)] = value
  }
  const hasWorkspaces = 'pinned' in entries || 'order' in entries || Object.keys(layouts).length > 0
  const workspaces = hasWorkspaces
    ? readWorkspaces({
        v: 1,
        front: null,
        pinned: entries['pinned'] ?? [],
        layouts,
        order: entries['order'] ?? [],
      })
    : null
  return { tabs: entries['tabs'] ?? null, workspaces, pages }
}

/** The keys `next` sets (new or changed) and deletes, against `prev`. */
export function diffEntries(prev: Entries, next: Entries): { set: Entries; del: string[] } {
  const set: Entries = {}
  for (const [k, v] of Object.entries(next)) if (!(k in prev) || !sameValue(prev[k], v)) set[k] = v
  const del = Object.keys(prev).filter((k) => !(k in next))
  return { set, del }
}

/** `base` with `set` and `del` applied. */
export function patchEntries(base: Entries, set: Entries, del: readonly string[]): Entries {
  const out: Entries = { ...base, ...set }
  for (const k of del) delete out[k]
  return out
}

/** The web page tab ids a state's layouts and pins show (`web:<id>` panels). */
export function shownPages(state: MirrorState): Set<string> {
  const out = new Set<string>()
  const add = (panelId: string): void => {
    if (panelId.startsWith('web:')) out.add(panelId.slice('web:'.length))
  }
  for (const t of state.workspaces?.pinned ?? []) if (t.kind === 'web') out.add(t.id)
  for (const json of Object.values(state.workspaces?.layouts ?? {})) {
    for (const id of Object.keys(json.panels)) if (appTabOf(id) === null) add(id)
  }
  return out
}

/** The record layout.json keeps for `state`'s workspaces, with `front` filled in. */
export function savedWorkspaces(state: MirrorState, front: string | null): Record<string, unknown> {
  const w = state.workspaces ?? { front: null, pinned: [], layouts: {}, order: [] }
  return saveWorkspaces({ ...w, front })
}
