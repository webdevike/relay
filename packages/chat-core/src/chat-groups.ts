import type { Categories } from './categories'

/** Chats a group shows beyond its running ones before `Show N more`. */
export const RECENT_CHATS = 5
/** A chat file written within this window counts as running. */
export const RECENTLY_ACTIVE_MS = 600_000

export function isRecentlyActive(mtimeMs: number, nowMs: number): boolean {
  return nowMs - mtimeMs < RECENTLY_ACTIVE_MS
}

export interface ListRow {
  id: string
  file: string
  title: string
  mtimeMs: number
  running: boolean
  pinned: boolean
  archived: boolean
}

export interface GroupView {
  name: string
  custom: boolean
  collapsed: boolean
  total: number
  runningCount: number
  rows: ListRow[]
  hidden: number
}

export interface ListView {
  searching: boolean
  pinned: ListRow[]
  groups: GroupView[]
  archived: ListRow[]
}

export interface GroupOptions {
  query: string
  collapsed: ReadonlySet<string>
  expanded: ReadonlySet<string>
}

const newestFirst = (a: ListRow, b: ListRow) => b.mtimeMs - a.mtimeMs

/** The whole chat list view, for browsing and for searching. Pure: callers supply `running`. */
export function groupChats(
  rows: readonly ListRow[],
  cats: Categories,
  opts: GroupOptions,
): ListView {
  const query = opts.query.trim().toLowerCase()
  const searching = query.length > 0
  const matches = (r: ListRow) => !searching || r.title.toLowerCase().includes(query)

  const pinned = rows.filter((r) => r.pinned && !r.archived && matches(r)).sort(newestFirst)
  const archived = searching ? [] : rows.filter((r) => r.archived).sort(newestFirst)

  const members = rows.filter((r) => {
    if (r.pinned && !r.archived) return false
    if (r.archived && !searching) return false
    return matches(r)
  })

  const byGroup = new Map<string, ListRow[]>()
  for (const r of members) {
    const name = cats.categoryOf(r.id, r.title)
    const list = byGroup.get(name)
    if (list) list.push(r)
    else byGroup.set(name, [r])
  }

  const ranked = cats.names()
  const names: string[] = []
  for (const n of ranked) {
    if (byGroup.has(n) || (!searching && cats.isCustom(n))) names.push(n)
  }
  const extra = [...byGroup.keys()].filter((n) => !ranked.includes(n))
  const newest = (n: string) => Math.max(...(byGroup.get(n) ?? []).map((r) => r.mtimeMs))
  const hasRunning = (n: string) => (byGroup.get(n) ?? []).some((r) => r.running)
  extra.sort((a, b) => Number(hasRunning(b)) - Number(hasRunning(a)) || newest(b) - newest(a))
  names.push(...extra)

  const groups: GroupView[] = names.map((name) => {
    const all = [...(byGroup.get(name) ?? [])].sort(
      (a, b) => Number(b.running) - Number(a.running) || newestFirst(a, b),
    )
    const total = all.length
    const runningCount = all.filter((r) => r.running).length
    const collapsed = !searching && opts.collapsed.has(name)
    const base = { name, custom: cats.isCustom(name), collapsed, total, runningCount }
    if (collapsed) return { ...base, rows: [], hidden: 0 }
    if (searching || opts.expanded.has(name)) return { ...base, rows: all, hidden: 0 }
    const visible = runningCount + RECENT_CHATS
    return {
      ...base,
      rows: all.slice(0, visible),
      hidden: Math.max(0, total - visible),
    }
  })

  return { searching, pinned, groups, archived }
}
