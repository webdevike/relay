import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

/** What a Recent row reopens: a page, a file (absolute path), or a tool (a TOOLS id). */
export type RecentKind = 'url' | 'file' | 'tool'

export interface RecentItem {
  kind: RecentKind
  /** The URL, the absolute path, or the tool id; one row per kind and target. */
  target: string
  name: string
  /** The dimmed part on the right: a page title, a folder, or "Tool". */
  where: string
}

const KEY = 'eva.launcher.recent'
/** Kept a little past the five the launcher shows, so a closed duplicate does not leave a gap. */
const KEEP = 12

function load(): RecentItem[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (x): x is RecentItem =>
          typeof x === 'object' &&
          x !== null &&
          ['url', 'file', 'tool'].includes((x as RecentItem).kind) &&
          typeof (x as RecentItem).target === 'string' &&
          typeof (x as RecentItem).name === 'string' &&
          typeof (x as RecentItem).where === 'string',
      )
      .slice(0, KEEP)
  } catch {
    return []
  }
}

export const recentStore = createStore<{ items: RecentItem[] }>(() => ({ items: load() }))

export function useRecent(): RecentItem[] {
  return useStore(recentStore, (s) => s.items)
}

/** Puts `item` first, replacing an earlier row for the same target; persisted per window. */
export function recordRecent(item: RecentItem): void {
  const prev = recentStore.getState().items
  if (prev[0]?.kind === item.kind && prev[0].target === item.target && prev[0].where === item.where)
    return
  const items = [
    item,
    ...prev.filter((i) => !(i.kind === item.kind && i.target === item.target)),
  ].slice(0, KEEP)
  recentStore.setState({ items })
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    // Storage off: the list lasts until the window closes.
  }
}

/** A page's row: `host/path` for the name, its title as the location. */
export function recordPage(url: string, title: string): void {
  let name: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return
    name = `${u.host}${u.pathname === '/' ? '' : u.pathname}`
  } catch {
    return
  }
  recordRecent({ kind: 'url', target: url, name, where: title === url ? '' : title })
}

/** A file's row: its name, the folder as the location. */
export function recordFile(root: string, path: string): void {
  const at = path.lastIndexOf('/')
  const folder = root.split('/').pop() ?? root
  recordRecent({
    kind: 'file',
    target: `${root}/${path}`,
    name: path.slice(at + 1),
    where: at > 0 ? `${folder}/${path.slice(0, at)}` : folder,
  })
}

/** Test seam. */
export function resetRecentForTests(): void {
  recentStore.setState({ items: [] })
  localStorage.removeItem(KEY)
}
