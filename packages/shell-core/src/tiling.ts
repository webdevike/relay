/**
 * The window's tiling: a recursive split tree of panes, like tmux or VS Code editor groups.
 * Pure data and operations only (no DOM): the renderer store applies them and persists the tree
 * to layout.json (`tiling`), and agents read and drive it through the control API.
 *
 * One pane is the chat pane (`CHAT_PANE`): it holds the app tabs (chats and pages, kept by the
 * tabs store), so its own `tabs` stay empty and it is never closed. Every other pane holds tool
 * tabs. A tab's id comes from what it shows, so one thing is open once: opening it again focuses
 * it (or moves it, when another pane is named).
 */
import { MAIN_MIN } from './fit'
import { placeFromJson, placeKey, placeToJson, type Place } from './place'

export const CHAT_PANE = 'chat'
/** Smallest tool pane a divider drag leaves (px). The chat pane keeps MAIN_MIN wide. */
export const TILE_MIN_W = 240
export const TILE_MIN_H = 140
export const CHAT_MIN_H = 240
/** The default tool pane's share of the tiling width. */
export const TOOL_PANE_SHARE = 0.34
const SIZE_MIN = 0.05

export type ToolKind = 'browser' | 'files'
export const TOOL_KINDS: readonly ToolKind[] = ['browser', 'files']

export type PaneTab =
  | { kind: ToolKind }
  | {
      kind: 'subagent'
      /** The chat session file the subagent belongs to. */
      session: string
      /** Absolute path of the subagent `.jsonl` transcript. */
      file: string
      name: string
    }
  | {
      kind: 'experiment-arm'
      /** Folder name under work/experiments. */
      experiment: string
      arm: string
      label: string
    }
  /** Any page but a chat (Test Bench, Canvas, Jobs, a workspace...). */
  | { kind: 'page'; place: Place }
export type PaneTabKind = PaneTab['kind']
export type SubagentTab = Extract<PaneTab, { kind: 'subagent' }>
export type ExperimentArmTab = Extract<PaneTab, { kind: 'experiment-arm' }>

export type SplitDir = 'row' | 'column'
export type Side = 'left' | 'right' | 'up' | 'down'

export interface PaneNode {
  type: 'pane'
  id: string
  tabs: PaneTab[]
  /** The tab in front, by tab id; null only for the chat pane. */
  active: string | null
}

export interface SplitNode {
  type: 'split'
  id: string
  /** `row`: children side by side; `column`: stacked. */
  dir: SplitDir
  children: TileNode[]
  /** Shares of the split's length, one per child, summing to 1. */
  sizes: number[]
}

export type TileNode = PaneNode | SplitNode

export interface Tiling {
  root: TileNode
  /** The pane keyboard actions and new tabs go to. */
  focus: string
  /** The pane maximized over the others, if any. */
  zoom: string | null
  /** The tool pane focused last: where a new tab opens while the chat pane has focus. */
  lastTool: string | null
  /** Next id counter for new panes and splits. */
  seq: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface DividerRect {
  split: string
  /** The divider sits after child `index`. */
  index: number
  dir: SplitDir
  rect: Rect
}

// Tabs ----------------------------------------------------------------------------------------

export const isToolKind = (v: unknown): v is ToolKind => v === 'browser' || v === 'files'

/** A page a tool pane can show: anything but a chat (an assistant's thread is a page like any other). */
export function pageTabAllowed(place: Place): boolean {
  return place.page !== 'chat'
}

export function tabId(tab: PaneTab): string {
  switch (tab.kind) {
    case 'subagent':
      return `subagent:${tab.file}`
    case 'experiment-arm':
      return `arm:${tab.experiment}/${tab.arm}`
    case 'page':
      return placeKey(tab.place)
    default:
      return tab.kind
  }
}

// Queries -------------------------------------------------------------------------------------

export function allPanes(node: TileNode): PaneNode[] {
  return node.type === 'pane' ? [node] : node.children.flatMap(allPanes)
}

export function findPane(t: Tiling, id: string): PaneNode | null {
  return allPanes(t.root).find((p) => p.id === id) ?? null
}

export function findNode(node: TileNode, id: string): TileNode | null {
  if (node.id === id) return node
  if (node.type === 'pane') return null
  for (const c of node.children) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

/** The pane holding `id`, and the tab. */
export function findTab(t: Tiling, id: string): { pane: PaneNode; tab: PaneTab } | null {
  for (const pane of allPanes(t.root)) {
    const tab = pane.tabs.find((x) => tabId(x) === id)
    if (tab) return { pane, tab }
  }
  return null
}

export function parentOf(node: TileNode, id: string): { split: SplitNode; index: number } | null {
  if (node.type === 'pane') return null
  const index = node.children.findIndex((c) => c.id === id)
  if (index >= 0) return { split: node, index }
  for (const c of node.children) {
    const hit = parentOf(c, id)
    if (hit) return hit
  }
  return null
}

export const isChatPane = (id: string): boolean => id === CHAT_PANE

/** Panes on screen: the zoomed one alone, else all of them. */
export function visiblePaneIds(t: Tiling): string[] {
  if (t.zoom !== null && findPane(t, t.zoom)) return [t.zoom]
  return allPanes(t.root).map((p) => p.id)
}

/** A tab is visible when it is in front of a pane on screen. */
export function isTabVisible(t: Tiling, id: string): boolean {
  const hit = findTab(t, id)
  if (!hit || hit.pane.active !== id) return false
  return visiblePaneIds(t).includes(hit.pane.id)
}

/** The tab in front of each pane on screen. */
export function frontTabs(t: Tiling): PaneTab[] {
  const shown = visiblePaneIds(t)
  return allPanes(t.root).flatMap((p) => {
    if (!shown.includes(p.id)) return []
    const tab = p.tabs.find((x) => tabId(x) === p.active)
    return tab ? [tab] : []
  })
}

/** Some tool pane is on screen next to (or instead of) the chat. */
export function toolsShown(t: Tiling): boolean {
  return visiblePaneIds(t).some((id) => !isChatPane(id))
}

/** Where a new tool tab goes: the focused tool pane, the last one, else the first. */
export function preferredToolPane(t: Tiling): PaneNode | null {
  const tools = allPanes(t.root).filter((p) => !isChatPane(p.id))
  return (
    tools.find((p) => p.id === t.focus) ??
    tools.find((p) => p.id === t.lastTool) ??
    tools[0] ??
    null
  )
}

// Construction --------------------------------------------------------------------------------

const chatLeaf = (): PaneNode => ({ type: 'pane', id: CHAT_PANE, tabs: [], active: null })

/** Today's shell: the chat, and one tool pane on the right with Browser and Files. */
export function defaultTiling(share = TOOL_PANE_SHARE, tool: ToolKind = 'browser'): Tiling {
  const s = clampShare(share)
  return {
    root: {
      type: 'split',
      id: 's1',
      dir: 'row',
      children: [chatLeaf(), toolPane('p2', tool)],
      sizes: [1 - s, s],
    },
    focus: CHAT_PANE,
    zoom: null,
    lastTool: 'p2',
    seq: 3,
  }
}

function toolPane(id: string, active: ToolKind): PaneNode {
  return { type: 'pane', id, tabs: TOOL_KINDS.map((kind) => ({ kind })), active }
}

const clampShare = (n: number): number =>
  Number.isFinite(n) ? Math.min(Math.max(n, SIZE_MIN), 1 - SIZE_MIN) : TOOL_PANE_SHARE

// Operations (immutable; each returns a normalized tree) -------------------------------------

export class TilingError extends Error {
  constructor(
    readonly code: 'not-found' | 'not-allowed' | 'invalid-params',
    message: string,
  ) {
    super(message)
  }
}

function mapNode(node: TileNode, fn: (n: TileNode) => TileNode): TileNode {
  const next =
    node.type === 'split' ? { ...node, children: node.children.map((c) => mapNode(c, fn)) } : node
  return fn(next)
}

function updatePane(root: TileNode, id: string, fn: (p: PaneNode) => PaneNode): TileNode {
  return mapNode(root, (n) => (n.type === 'pane' && n.id === id ? fn(n) : n))
}

function nextId(t: Tiling, prefix: 'p' | 's'): [string, Tiling] {
  return [`${prefix}${t.seq}`, { ...t, seq: t.seq + 1 }]
}

/** Drops empty tool panes, unwraps one-child splits, flattens same-direction nesting, fixes sizes. */
export function normalize(node: TileNode): TileNode | null {
  if (node.type === 'pane') {
    if (isChatPane(node.id)) return node.tabs.length || node.active ? chatLeaf() : node
    if (node.tabs.length === 0) return null
    const ids = node.tabs.map(tabId)
    return node.active !== null && ids.includes(node.active) ? node : { ...node, active: ids[0]! }
  }
  const children: TileNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    const n = normalize(c)
    const share = node.sizes[i] ?? 0
    if (!n) return
    if (n.type === 'split' && n.dir === node.dir) {
      n.children.forEach((g, j) => {
        children.push(g)
        sizes.push(share * (n.sizes[j] ?? 0))
      })
      return
    }
    children.push(n)
    sizes.push(share)
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]!
  return { ...node, children, sizes: fixSizes(sizes) }
}

function fixSizes(sizes: number[]): number[] {
  const clean = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0))
  const total = clean.reduce((a, b) => a + b, 0)
  if (total <= 0) return clean.map(() => 1 / clean.length)
  return clean.map((s) => s / total)
}

function finish(t: Tiling): Tiling {
  const root = normalize(t.root) ?? chatLeaf()
  const ids = allPanes(root).map((p) => p.id)
  const focus = ids.includes(t.focus) ? t.focus : CHAT_PANE
  const zoom = t.zoom !== null && ids.includes(t.zoom) ? t.zoom : null
  const lastTool = t.lastTool !== null && ids.includes(t.lastTool) ? t.lastTool : null
  return { ...t, root, focus, zoom, lastTool: !isChatPane(focus) ? focus : lastTool }
}

/** Removes a tab from its pane (the pane may be left empty; finish() drops it). */
function detachTab(t: Tiling, id: string): Tiling {
  const hit = findTab(t, id)
  if (!hit) return t
  const { pane } = hit
  const ids = pane.tabs.map(tabId)
  const at = ids.indexOf(id)
  const rest = pane.tabs.filter((_, i) => i !== at)
  const active = pane.active === id ? (ids[at + 1] ?? ids[at - 1] ?? null) : pane.active
  return {
    ...t,
    root: updatePane(t.root, pane.id, (p) => ({
      ...p,
      tabs: rest,
      active: active === id ? null : active,
    })),
  }
}

function insertBeside(
  t: Tiling,
  targetId: string,
  side: Side,
  node: TileNode,
  share: number,
): Tiling {
  const dir: SplitDir = side === 'left' || side === 'right' ? 'row' : 'column'
  const after = side === 'right' || side === 'down'
  const s = clampShare(share)
  const target = findNode(t.root, targetId)
  if (target?.type === 'split' && target.dir === dir) {
    // Beside a whole group running the same way: it becomes the group's first or last child.
    const sizes = target.sizes.map((v) => v * (1 - s))
    const grown: SplitNode = {
      ...target,
      children: after ? [...target.children, node] : [node, ...target.children],
      sizes: after ? [...sizes, s] : [s, ...sizes],
    }
    return { ...t, root: mapNode(t.root, (n) => (n.id === targetId ? grown : n)) }
  }
  const parent = parentOf(t.root, targetId)
  if (parent && parent.split.dir === dir) {
    const { split, index } = parent
    const own = split.sizes[index] ?? 1 / split.children.length
    const children = [...split.children]
    const sizes = [...split.sizes]
    const at = after ? index + 1 : index
    children.splice(at, 0, node)
    sizes[index] = own * (1 - s)
    sizes.splice(at, 0, own * s)
    return {
      ...t,
      root: mapNode(t.root, (n) => (n.id === split.id ? { ...split, children, sizes } : n)),
    }
  }
  const [sid, t2] = nextId(t, 's')
  const wrap = (target: TileNode): SplitNode => ({
    type: 'split',
    id: sid,
    dir,
    children: after ? [target, node] : [node, target],
    sizes: after ? [1 - s, s] : [s, 1 - s],
  })
  return { ...t2, root: mapNode(t2.root, (n) => (n.id === targetId ? wrap(n) : n)) }
}

/**
 * Splits `paneId` (a pane, or a split id to put the new pane beside that whole group) on `side`
 * with a new pane showing `tab`, moved there when it is open elsewhere. `share` is the new pane's
 * part of the space it splits.
 */
export function splitPane(
  t: Tiling,
  paneId: string,
  side: Side,
  tab: PaneTab,
  share = 0.5,
): { tiling: Tiling; pane: string } {
  if (!findNode(t.root, paneId)) throw new TilingError('not-found', `No pane ${paneId}`)
  if (tab.kind === 'page' && !pageTabAllowed(tab.place)) {
    throw new TilingError('not-allowed', 'Chats stay in the chat pane')
  }
  const id = tabId(tab)
  const from = findTab(t, id)
  if (from && from.pane.id === paneId && from.pane.tabs.length === 1) {
    return { tiling: t, pane: paneId }
  }
  let next = detachTab(t, id)
  const [pid, withId] = nextId(next, 'p')
  next = withId
  const pane: PaneNode = { type: 'pane', id: pid, tabs: [from?.tab ?? tab], active: id }
  next = insertBeside(next, paneId, side, pane, share)
  return { tiling: finish({ ...next, focus: pid }), pane: pid }
}

/** Puts `tab` into `paneId` at `index` (default after its active tab), moving it if open elsewhere. */
export function movePaneTab(t: Tiling, tab: PaneTab, paneId: string, index?: number): Tiling {
  if (isChatPane(paneId)) {
    throw new TilingError(
      'not-allowed',
      'The chat pane holds only chats and pages: split it instead',
    )
  }
  if (!findPane(t, paneId)) throw new TilingError('not-found', `No pane ${paneId}`)
  if (tab.kind === 'page' && !pageTabAllowed(tab.place)) {
    throw new TilingError('not-allowed', 'Chats stay in the chat pane')
  }
  const id = tabId(tab)
  const from = findTab(t, id)
  const moved = from?.tab ?? tab
  let next = detachTab(t, id)
  next = {
    ...next,
    root: updatePane(next.root, paneId, (p) => {
      const tabs = [...p.tabs]
      const activeAt = p.active === null ? -1 : tabs.findIndex((x) => tabId(x) === p.active)
      const at =
        index === undefined
          ? activeAt + 1 || tabs.length
          : Math.min(Math.max(Math.trunc(index), 0), tabs.length)
      tabs.splice(at, 0, moved)
      return { ...p, tabs, active: id }
    }),
  }
  return finish({ ...next, focus: paneId })
}

/**
 * Shows `tab`: in front where it already is, else in `paneId` (or the preferred tool pane);
 * with no tool pane, a new one opens right of the chat. Naming a pane moves an open tab there.
 */
export function openPaneTab(t: Tiling, tab: PaneTab, paneId?: string): Tiling {
  const id = tabId(tab)
  const hit = findTab(t, id)
  if (hit && (paneId === undefined || paneId === hit.pane.id)) {
    const root = updatePane(t.root, hit.pane.id, (p) => ({
      ...p,
      // A transient view's details (its label) follow the latest open.
      tabs: p.tabs.map((x) => (tabId(x) === id ? tab : x)),
      active: id,
    }))
    return finish({ ...t, root, focus: hit.pane.id, zoom: unzoomFor(t, hit.pane.id) })
  }
  if (paneId !== undefined) return { ...movePaneTab(t, tab, paneId), zoom: unzoomFor(t, paneId) }
  const target = preferredToolPane(t)
  if (target) return { ...movePaneTab(t, tab, target.id), zoom: unzoomFor(t, target.id) }
  const chat = CHAT_PANE
  const { tiling } = splitPane({ ...t, zoom: null }, chat, 'right', tab, TOOL_PANE_SHARE)
  return tiling
}

/** A zoom that would hide `paneId` ends. */
function unzoomFor(t: Tiling, paneId: string): string | null {
  return t.zoom === null || t.zoom === paneId ? t.zoom : null
}

/**
 * Swaps tab `id` for `tab` in place (a page that settled on what it shows, like Canvas picking
 * the newest board). When `tab` is already open elsewhere, `id` closes and that one comes forward.
 */
export function replacePaneTab(t: Tiling, id: string, tab: PaneTab): Tiling {
  const hit = findTab(t, id)
  if (!hit) throw new TilingError('not-found', `No tab ${id}`)
  const next = tabId(tab)
  if (next === id) return t
  if (findTab(t, next)) return activatePaneTab(finish(detachTab(t, id)), next)
  const root = updatePane(t.root, hit.pane.id, (p) => ({
    ...p,
    tabs: p.tabs.map((x) => (tabId(x) === id ? tab : x)),
    active: p.active === id ? next : p.active,
  }))
  return { ...t, root }
}

export function closePaneTab(t: Tiling, id: string): Tiling {
  if (!findTab(t, id)) throw new TilingError('not-found', `No tab ${id}`)
  return finish(detachTab(t, id))
}

export function closePane(t: Tiling, paneId: string): Tiling {
  if (isChatPane(paneId)) throw new TilingError('not-allowed', 'The chat pane cannot close')
  if (!findPane(t, paneId)) throw new TilingError('not-found', `No pane ${paneId}`)
  const parent = parentOf(t.root, paneId)
  // Focus goes to the pane beside the closed one (the one before it, else after).
  const sibling = parent
    ? (parent.split.children[parent.index - 1] ?? parent.split.children[parent.index + 1])
    : null
  const nextFocus =
    t.focus === paneId ? (sibling ? (allPanes(sibling)[0]?.id ?? CHAT_PANE) : CHAT_PANE) : t.focus
  const root = updatePane(t.root, paneId, (p) => ({ ...p, tabs: [], active: null }))
  return finish({ ...t, root, focus: nextFocus, zoom: t.zoom === paneId ? null : t.zoom })
}

export function activatePaneTab(t: Tiling, id: string): Tiling {
  const hit = findTab(t, id)
  if (!hit) throw new TilingError('not-found', `No tab ${id}`)
  const root = updatePane(t.root, hit.pane.id, (p) => ({ ...p, active: id }))
  return finish({ ...t, root, focus: hit.pane.id, zoom: unzoomFor(t, hit.pane.id) })
}

export function focusPane(t: Tiling, paneId: string): Tiling {
  if (!findPane(t, paneId)) throw new TilingError('not-found', `No pane ${paneId}`)
  if (t.focus === paneId) return t
  return finish({ ...t, focus: paneId, zoom: unzoomFor(t, paneId) })
}

export function setZoom(t: Tiling, paneId: string | null): Tiling {
  if (paneId !== null && !findPane(t, paneId))
    throw new TilingError('not-found', `No pane ${paneId}`)
  return finish({ ...t, zoom: paneId, focus: paneId ?? t.focus })
}

/** Sets `paneId`'s share of its parent split; the siblings keep their proportions. */
export function resizePane(t: Tiling, paneId: string, share: number): Tiling {
  if (!findNode(t.root, paneId)) throw new TilingError('not-found', `No pane ${paneId}`)
  const parent = parentOf(t.root, paneId)
  if (!parent) throw new TilingError('not-allowed', `Pane ${paneId} fills the window`)
  const { split, index } = parent
  const s = clampShare(share)
  const others = split.sizes.reduce((a, b, i) => (i === index ? a : a + b), 0)
  const sizes = split.sizes.map((v, i) =>
    i === index ? s : others > 0 ? (v / others) * (1 - s) : (1 - s) / (split.sizes.length - 1),
  )
  return setSplitSizes(t, split.id, sizes)
}

export function setSplitSizes(t: Tiling, splitId: string, sizes: readonly number[]): Tiling {
  const node = findNode(t.root, splitId)
  if (!node || node.type !== 'split') throw new TilingError('not-found', `No split ${splitId}`)
  if (sizes.length !== node.children.length) {
    throw new TilingError('invalid-params', `Split ${splitId} has ${node.children.length} children`)
  }
  const fixed = fixSizes([...sizes])
  return {
    ...t,
    root: mapNode(t.root, (n) => (n.id === splitId ? { ...node, sizes: fixed } : n)),
  }
}

// Geometry ------------------------------------------------------------------------------------

export interface TilingRects {
  panes: Record<string, Rect>
  splits: Record<string, Rect>
  dividers: DividerRect[]
}

/** Px rects of every pane, split and divider inside `box`, with `gap` between siblings. */
export function layoutRects(root: TileNode, box: Rect, gap: number): TilingRects {
  const panes: Record<string, Rect> = {}
  const splits: Record<string, Rect> = {}
  const dividers: DividerRect[] = []
  const walk = (node: TileNode, r: Rect): void => {
    if (node.type === 'pane') {
      panes[node.id] = r
      return
    }
    splits[node.id] = r
    const row = node.dir === 'row'
    const length = row ? r.w : r.h
    const free = Math.max(length - gap * (node.children.length - 1), 0)
    let at = row ? r.x : r.y
    node.children.forEach((c, i) => {
      const last = i === node.children.length - 1
      const end = row ? r.x + r.w : r.y + r.h
      const size = last ? end - at : Math.round(free * (node.sizes[i] ?? 0))
      walk(c, row ? { x: at, y: r.y, w: size, h: r.h } : { x: r.x, y: at, w: r.w, h: size })
      at += size
      if (!last) {
        dividers.push({
          split: node.id,
          index: i,
          dir: node.dir,
          rect: row ? { x: at, y: r.y, w: gap, h: r.h } : { x: r.x, y: at, w: r.w, h: gap },
        })
        at += gap
      }
    })
  }
  walk(root, box)
  return { panes, splits, dividers }
}

/** The smallest px size `node` can take along an axis, gaps included. */
export function minSize(node: TileNode, axis: 'w' | 'h', gap: number): number {
  if (node.type === 'pane') {
    if (isChatPane(node.id)) return axis === 'w' ? MAIN_MIN : CHAT_MIN_H
    return axis === 'w' ? TILE_MIN_W : TILE_MIN_H
  }
  const along = (node.dir === 'row') === (axis === 'w')
  const mins = node.children.map((c) => minSize(c, axis, gap))
  return along ? mins.reduce((a, b) => a + b, 0) + gap * (mins.length - 1) : Math.max(...mins)
}

/** The pane next to `from` in direction `side` (most overlap among the nearest), if any. */
export function neighbor(rects: Record<string, Rect>, from: string, side: Side): string | null {
  const a = rects[from]
  if (!a) return null
  let best: { id: string; dist: number; overlap: number } | null = null
  for (const [id, b] of Object.entries(rects)) {
    if (id === from) continue
    const horizontal = side === 'left' || side === 'right'
    const dist =
      side === 'right'
        ? b.x - (a.x + a.w)
        : side === 'left'
          ? a.x - (b.x + b.w)
          : side === 'down'
            ? b.y - (a.y + a.h)
            : a.y - (b.y + b.h)
    if (dist < -1) continue
    const overlap = horizontal
      ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    if (overlap <= 0) continue
    if (
      !best ||
      dist < best.dist - 1 ||
      (Math.abs(dist - best.dist) <= 1 && overlap > best.overlap)
    ) {
      best = { id, dist, overlap }
    }
  }
  return best?.id ?? null
}

// Persistence ---------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096

function tabToJson(tab: PaneTab): unknown {
  return tab.kind === 'page' ? { kind: 'page', place: placeToJson(tab.place) } : tab
}

/** One saved tab, or null when it is not a tab this build knows. */
export function tabFromJson(v: unknown): PaneTab | null {
  if (!isObject(v)) return null
  const kind = v['kind']
  if (isToolKind(kind)) return { kind }
  if (kind === 'subagent' && str(v['session']) && str(v['file']) && str(v['name'])) {
    return { kind, session: v['session'], file: v['file'], name: v['name'] }
  }
  if (kind === 'experiment-arm' && str(v['experiment']) && str(v['arm']) && str(v['label'])) {
    return { kind, experiment: v['experiment'], arm: v['arm'], label: v['label'] }
  }
  if (kind === 'page') {
    const place = placeFromJson(v['place'])
    return place && pageTabAllowed(place) ? { kind, place } : null
  }
  return null
}

function nodeToJson(node: TileNode): unknown {
  if (node.type === 'pane') {
    return { type: 'pane', id: node.id, tabs: node.tabs.map(tabToJson), active: node.active }
  }
  return {
    type: 'split',
    id: node.id,
    dir: node.dir,
    sizes: node.sizes.map((s) => Math.round(s * 10_000) / 10_000),
    children: node.children.map(nodeToJson),
  }
}

/** The layout.json `tiling` value. */
export function tilingToJson(t: Tiling): Record<string, unknown> {
  return {
    version: 1,
    root: nodeToJson(t.root),
    focus: t.focus,
    zoom: t.zoom,
    last_tool: t.lastTool,
    seq: t.seq,
  }
}

const MAX_DEPTH = 12
const MAX_PANES = 32

/**
 * Reads a saved `tiling`: unknown tabs, duplicate tabs and ids, and empty panes drop out; a tree
 * without the chat pane gets it back on the left. null when nothing usable is there.
 */
export function tilingFromJson(v: unknown): Tiling | null {
  if (!isObject(v) || !isObject(v['root'])) return null
  const seenTabs = new Set<string>()
  const seenIds = new Set<string>()
  let panes = 0
  let chat = false
  let maxSeq = 0
  const claim = (raw: unknown, prefix: 'p' | 's'): string | null => {
    if (!str(raw) || raw.length > 64 || seenIds.has(raw)) return null
    const n = /^[ps](\d+)$/.exec(raw)
    if (n) maxSeq = Math.max(maxSeq, Number(n[1]))
    else if (raw !== CHAT_PANE || prefix !== 'p') return null
    seenIds.add(raw)
    return raw
  }
  const read = (raw: unknown, depth: number): TileNode | null => {
    if (!isObject(raw) || depth > MAX_DEPTH) return null
    if (raw['type'] === 'pane') {
      if (panes >= MAX_PANES) return null
      const id = claim(raw['id'], 'p')
      if (id === null) return null
      panes++
      if (isChatPane(id)) {
        chat = true
        return chatLeaf()
      }
      const tabs: PaneTab[] = []
      for (const x of Array.isArray(raw['tabs']) ? raw['tabs'] : []) {
        const tab = tabFromJson(x)
        if (!tab || seenTabs.has(tabId(tab))) continue
        seenTabs.add(tabId(tab))
        tabs.push(tab)
      }
      const active = typeof raw['active'] === 'string' ? raw['active'] : null
      return { type: 'pane', id, tabs, active }
    }
    if (raw['type'] === 'split') {
      const id = claim(raw['id'], 's')
      const dir = raw['dir']
      if (id === null || (dir !== 'row' && dir !== 'column')) return null
      const rawChildren = Array.isArray(raw['children']) ? raw['children'] : []
      const rawSizes = Array.isArray(raw['sizes']) ? raw['sizes'] : []
      const children: TileNode[] = []
      const sizes: number[] = []
      rawChildren.forEach((c, i) => {
        const n = read(c, depth + 1)
        if (!n) return
        children.push(n)
        const s = rawSizes[i]
        sizes.push(
          typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1 / rawChildren.length,
        )
      })
      return { type: 'split', id, dir, children, sizes }
    }
    return null
  }
  let root = read(v['root'], 0)
  if (root === null) return null
  let seq = maxSeq + 1
  if (!chat) {
    root = {
      type: 'split',
      id: `s${seq++}`,
      dir: 'row',
      children: [chatLeaf(), root],
      sizes: [1 - TOOL_PANE_SHARE, TOOL_PANE_SHARE],
    }
  }
  const focus = typeof v['focus'] === 'string' ? v['focus'] : CHAT_PANE
  const zoom = typeof v['zoom'] === 'string' ? v['zoom'] : null
  const lastTool = typeof v['last_tool'] === 'string' ? v['last_tool'] : null
  const savedSeq = typeof v['seq'] === 'number' && Number.isInteger(v['seq']) ? v['seq'] : 0
  return finish({ root, focus, zoom, lastTool, seq: Math.max(seq, savedSeq) })
}
