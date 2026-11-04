import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { pageFromKey, type PageKey } from '@evaos/shell-core'
import { invoke } from '../ipc'

/** When a row or a section is drawn: always, only while it carries a badge, or never. */
export type Visibility = 'always' | 'badged' | 'never'
/** How a badge reads: the number, a dot, or nothing at all. */
export type BadgeStyle = 'count' | 'dot' | 'none'

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  always: 'Always show',
  badged: 'Show when badged',
  never: "Don't show",
}
export const BADGE_LABEL: Record<BadgeStyle, string> = {
  count: 'Count',
  dot: 'Dot',
  none: 'None',
}
const VISIBILITIES = Object.keys(VISIBILITY_LABEL) as Visibility[]
const BADGE_STYLES = Object.keys(BADGE_LABEL) as BadgeStyle[]

/** The sections that can be customised; Favorites is its own, always on, and keeps its own list. */
export type SectionId = 'main' | 'dashboards'
export const SECTION_IDS: readonly SectionId[] = ['main', 'dashboards']
export const SECTION_TITLE: Record<SectionId, string> = { main: 'Main', dashboards: 'Dashboards' }
export const FAVORITES_ID = 'favorites'

/** A favorited page or chat. `title` and `icon` are what it was called when it was added. */
export interface FavItem {
  kind: 'item'
  id: string
  page: PageKey
  /** The session file of a chat favorite, else null. */
  chat: string | null
  title: string
  icon: string
}
export interface FavFolder {
  kind: 'folder'
  id: string
  name: string
  open: boolean
  items: FavItem[]
}
export type FavNode = FavItem | FavFolder

export interface SidebarPrefs {
  badgeStyle: BadgeStyle
  /** Row id, or `section:<id>`, to its visibility; a missing key is `always`. */
  visibility: Record<string, Visibility>
  /** Row ids in the order the user dragged them, per section; unknown rows follow in default order. */
  order: Record<string, string[]>
  /** Section ids (and `favorites`) whose rows are folded away. */
  collapsed: Record<string, boolean>
  favorites: FavNode[]
}

export const defaultPrefs = (): SidebarPrefs => ({
  badgeStyle: 'count',
  visibility: {},
  order: {},
  collapsed: {},
  favorites: [],
})

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null

function parseItem(v: unknown): FavItem | null {
  if (!isObject(v) || v['kind'] !== 'item') return null
  const id = text(v['id'], 600)
  const title = text(v['title'], 400)
  const icon = text(v['icon'], 80)
  const page = typeof v['page'] === 'string' ? pageFromKey(v['page']) : null
  const chat = v['chat'] === null ? null : text(v['chat'], 1000)
  if (id === null || title === null || icon === null || page === null) return null
  if (v['chat'] !== null && chat === null) return null
  return { kind: 'item', id, page, chat, title, icon }
}

function parseNode(v: unknown): FavNode | null {
  if (isObject(v) && v['kind'] === 'folder') {
    const id = text(v['id'], 100)
    const name = text(v['name'], 120)
    if (id === null || name === null || !Array.isArray(v['items'])) return null
    const items = v['items'].map(parseItem).filter((i): i is FavItem => i !== null)
    return { kind: 'folder', id, name, open: v['open'] !== false, items }
  }
  return parseItem(v)
}

/** Saved settings read back safely: anything malformed falls to its default, nothing throws. */
export function parsePrefs(raw: unknown): SidebarPrefs {
  const out = defaultPrefs()
  if (!isObject(raw)) return out
  if (BADGE_STYLES.includes(raw['badgeStyle'] as BadgeStyle)) {
    out.badgeStyle = raw['badgeStyle'] as BadgeStyle
  }
  if (isObject(raw['visibility'])) {
    for (const [k, v] of Object.entries(raw['visibility'])) {
      if (VISIBILITIES.includes(v as Visibility)) out.visibility[k] = v as Visibility
    }
  }
  if (isObject(raw['order'])) {
    for (const [k, v] of Object.entries(raw['order'])) {
      if (Array.isArray(v)) out.order[k] = v.filter((s): s is string => typeof s === 'string')
    }
  }
  if (isObject(raw['collapsed'])) {
    for (const [k, v] of Object.entries(raw['collapsed'])) if (v === true) out.collapsed[k] = true
  }
  if (Array.isArray(raw['favorites'])) {
    const seen = new Set<string>()
    for (const n of raw['favorites']) {
      const node = parseNode(n)
      if (node === null) continue
      if (node.kind === 'item') {
        if (seen.has(node.id)) continue
        seen.add(node.id)
        out.favorites.push(node)
      } else {
        node.items = node.items.filter((i) => !seen.has(i.id) && !!seen.add(i.id))
        out.favorites.push(node)
      }
    }
  }
  return out
}

/** `items` in the saved order; rows the order has not met (a new board) follow in their own order. */
export function inOrder<T extends { id: string }>(
  items: readonly T[],
  order?: readonly string[],
): T[] {
  if (!order || order.length === 0) return [...items]
  const rank = new Map(order.map((id, i) => [id, i]))
  const known = items
    .filter((i) => rank.has(i.id))
    .sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  return [...known, ...items.filter((i) => !rank.has(i.id))]
}

/** `ids` with `from` placed where `to` is (the array-move a drop makes). */
export function moveId(ids: readonly string[], from: string, to: string): string[] {
  const a = ids.indexOf(from)
  const b = ids.indexOf(to)
  if (a < 0 || b < 0 || a === b) return [...ids]
  const out = [...ids]
  out.splice(a, 1)
  out.splice(b, 0, from)
  return out
}

/** Whether a row (or section) with this visibility is drawn, given whether it carries a badge. */
export const isShown = (v: Visibility | undefined, badged: boolean): boolean =>
  v === 'never' ? false : v === 'badged' ? badged : true

export const sectionKey = (id: string): string => `section:${id}`

export const favId = (page: string, chat: string | null): string => `fav:${page}|${chat ?? ''}`

export interface SidebarPrefsState extends SidebarPrefs {
  customizing: boolean
  setCustomizing(open: boolean): void
  setBadgeStyle(s: BadgeStyle): void
  setVisibility(key: string, v: Visibility): void
  /** The section's row ids in the new order. */
  setOrder(section: string, ids: string[]): void
  toggleCollapsed(section: string): void
  addFavorite(item: Omit<FavItem, 'kind' | 'id'>): void
  removeFavorite(id: string): void
  /** Appends a folder (open) and returns its id. */
  addFolder(name: string): string
  renameFolder(id: string, name: string): void
  /** Deletes the folder; its favorites move to the top level where the folder was. */
  deleteFolder(id: string): void
  toggleFolder(id: string): void
  /** Puts a favorite (or folder) where `overId` is, joining the folder it is dropped on or in. */
  dropFavorite(activeId: string, overId: string): void
  /** Moves a favorite into a folder, or to the top level with null. */
  moveToFolder(itemId: string, folderId: string | null): void
}

const pick = (s: SidebarPrefsState): SidebarPrefs => ({
  badgeStyle: s.badgeStyle,
  visibility: s.visibility,
  order: s.order,
  collapsed: s.collapsed,
  favorites: s.favorites,
})

function save(prefs: SidebarPrefs): void {
  void invoke('layout.save', { sidebar: { ...prefs } }).then((r) => {
    if (!r.ok) console.warn('sidebar save failed', r.error)
  })
}

const flat = (nodes: readonly FavNode[]): FavItem[] =>
  nodes.flatMap((n) => (n.kind === 'item' ? [n] : n.items))

/** Removes a favorite wherever it sits, returning what is left and the item. */
function take(nodes: FavNode[], id: string): { rest: FavNode[]; item: FavItem | null } {
  let item: FavItem | null = null
  const rest: FavNode[] = []
  for (const n of nodes) {
    if (n.kind === 'item') {
      if (n.id === id) item = n
      else rest.push(n)
    } else {
      const found = n.items.find((i) => i.id === id)
      if (found) item = found
      rest.push(found ? { ...n, items: n.items.filter((i) => i.id !== id) } : n)
    }
  }
  return { rest, item }
}

/**
 * The favorites after `activeId` is dropped on `overId`. A folder only reorders among folders and
 * favorites at the top level. A favorite dropped on a folder joins it; dropped on another favorite
 * it takes that favorite's place, in that favorite's folder or at the top level.
 */
export function dropNode(nodes: readonly FavNode[], activeId: string, overId: string): FavNode[] {
  if (activeId === overId) return [...nodes]
  const active = nodes.find((n) => n.id === activeId)
  if (active?.kind === 'folder') {
    const home = nodes.find(
      (n) => n.id === overId || (n.kind === 'folder' && n.items.some((i) => i.id === overId)),
    )
    if (!home) return [...nodes]
    const ids = moveId(
      nodes.map((n) => n.id),
      activeId,
      home.id,
    )
    return ids.map((id) => nodes.find((n) => n.id === id)!)
  }
  const { rest, item } = take([...nodes], activeId)
  if (item === null) return [...nodes]
  const target = nodes.find((n) => n.id === overId)
  if (target?.kind === 'folder') {
    return rest.map((n) =>
      n.id === overId && n.kind === 'folder' ? { ...n, open: true, items: [...n.items, item] } : n,
    )
  }
  // Inserting at the drop target's original index puts the item before it moving up and after it
  // moving down, as an array move does.
  const topAt = nodes.findIndex((n) => n.id === overId)
  if (topAt >= 0) return [...rest.slice(0, topAt), item, ...rest.slice(topAt)]
  return rest.map((n) => {
    if (n.kind !== 'folder') return n
    const orig = nodes.find((x) => x.id === n.id)
    const at = orig?.kind === 'folder' ? orig.items.findIndex((i) => i.id === overId) : -1
    return at < 0 ? n : { ...n, items: [...n.items.slice(0, at), item, ...n.items.slice(at)] }
  })
}

export const sidebarPrefsStore = createStore<SidebarPrefsState>((set, get) => {
  /** Applies `fn` to the saved part of the state, then saves. */
  const update = (fn: (p: SidebarPrefs) => Partial<SidebarPrefs>): void => {
    set(fn(pick(get())))
    save(pick(get()))
  }
  return {
    ...defaultPrefs(),
    customizing: false,
    setCustomizing: (customizing) => set({ customizing }),
    setBadgeStyle: (badgeStyle) => update(() => ({ badgeStyle })),
    setVisibility: (key, v) =>
      update((p) => {
        const visibility = { ...p.visibility }
        if (v === 'always') delete visibility[key]
        else visibility[key] = v
        return { visibility }
      }),
    setOrder: (section, ids) => update((p) => ({ order: { ...p.order, [section]: ids } })),
    toggleCollapsed: (section) =>
      update((p) => {
        const collapsed = { ...p.collapsed }
        if (collapsed[section]) delete collapsed[section]
        else collapsed[section] = true
        return { collapsed }
      }),
    addFavorite: (item) =>
      update((p) => {
        const id = favId(item.page, item.chat)
        if (flat(p.favorites).some((i) => i.id === id)) return {}
        return { favorites: [...p.favorites, { kind: 'item', id, ...item }] }
      }),
    removeFavorite: (id) => update((p) => ({ favorites: take(p.favorites, id).rest })),
    addFolder: (name) => {
      const id = `folder:${crypto.randomUUID()}`
      update((p) => {
        const collapsed = { ...p.collapsed }
        delete collapsed[FAVORITES_ID]
        return {
          favorites: [...p.favorites, { kind: 'folder', id, name, open: true, items: [] }],
          collapsed,
        }
      })
      return id
    },
    renameFolder: (id, name) =>
      update((p) => ({
        favorites: p.favorites.map((n) =>
          n.kind === 'folder' && n.id === id ? { ...n, name } : n,
        ),
      })),
    deleteFolder: (id) =>
      update((p) => ({
        favorites: p.favorites.flatMap((n) => (n.kind === 'folder' && n.id === id ? n.items : [n])),
      })),
    toggleFolder: (id) =>
      update((p) => ({
        favorites: p.favorites.map((n) =>
          n.kind === 'folder' && n.id === id ? { ...n, open: !n.open } : n,
        ),
      })),
    dropFavorite: (activeId, overId) =>
      update((p) => ({ favorites: dropNode(p.favorites, activeId, overId) })),
    moveToFolder: (itemId, folderId) =>
      update((p) => {
        const { rest, item } = take(p.favorites, itemId)
        if (item === null) return {}
        if (folderId === null) return { favorites: [...rest, item] }
        return {
          favorites: rest.map((n) =>
            n.kind === 'folder' && n.id === folderId
              ? { ...n, open: true, items: [...n.items, item] }
              : n,
          ),
        }
      }),
  }
})

export function useSidebarPrefs<T>(selector: (s: SidebarPrefsState) => T): T {
  return useStore(sidebarPrefsStore, selector)
}

/** The saved customization from layout.json (what layout.load returned); defaults when absent. */
export function applySidebarPrefs(raw: unknown): void {
  sidebarPrefsStore.setState(parsePrefs(raw))
}

export function resetSidebarPrefsForTests(): void {
  sidebarPrefsStore.setState({ ...defaultPrefs(), customizing: false })
}
