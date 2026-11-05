import type { SkillAssistant, SkillRow, SkillSource } from '@evaos/contract'

export type SkillSortKey = 'name' | 'updated'
export interface SkillSort {
  key: SkillSortKey
  dir: 'asc' | 'desc'
}
/** Name, A to Z. */
export const DEFAULT_SORT: SkillSort = { key: 'name', dir: 'asc' }

/** The Source select: `all`, or one source's label (`Eva`, `.agents`, a plugin's name). */
export const ANY = 'all'

export interface SkillFilter {
  query: string
  source: string
  /** An assistant id, or `all`. */
  usedBy: string
}

/** Rows matching the search (name or description, every word), the source and the assistant. */
export function filterSkills(rows: readonly SkillRow[], f: SkillFilter): SkillRow[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter((r) => {
    if (f.source !== ANY && r.source.label !== f.source) return false
    if (f.usedBy !== ANY && !r.usedBy.includes(f.usedBy)) return false
    if (words.length === 0) return true
    const hay = `${r.name}\n${r.description}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** A sorted copy; ties fall back to the name so the order is stable. */
export function sortSkills(rows: readonly SkillRow[], sort: SkillSort): SkillRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const by = sort.key === 'updated' ? a.updatedAt - b.updatedAt : a.name.localeCompare(b.name)
    return by === 0 ? a.name.localeCompare(b.name) : by * sign
  })
}

/** Clicking a header: the same column flips, another starts at its natural order. */
export function nextSort(sort: SkillSort, key: SkillSortKey): SkillSort {
  if (sort.key === key) return { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: key === 'name' ? 'asc' : 'desc' }
}

/** The Source select's options: every primary source label, in first-seen order. */
export function sourceLabels(rows: readonly SkillRow[]): string[] {
  return [...new Set(rows.map((r) => r.source.label))]
}

/** `Eva`, or `.agents +1` when other copies exist. */
export function sourcePill(row: { source: SkillSource; also: readonly SkillSource[] }): string {
  return row.also.length > 0 ? `${row.source.label} +${row.also.length}` : row.source.label
}

const DAY = 86_400_000

/** The Updated column by calendar day: `today`, `3d ago`, `2w ago`, `4mo ago`, `2y ago`. */
export function updatedLabel(at: number, now: number): string {
  const midnight = (t: number): number => new Date(t).setHours(0, 0, 0, 0)
  const days = Math.max(0, Math.round((midnight(now) - midnight(at)) / DAY))
  if (days === 0) return 'today'
  if (days < 14) return `${days}d ago`
  if (days < 60) return `${Math.floor(days / 7)}w ago`
  if (days < 730) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

/** Last used: `just now`, `5 minutes ago`, `2 hours ago`, `3 days ago`. */
export function lastUsedLabel(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  const count = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`
  if (minutes < 1) return 'just now'
  if (minutes < 60) return count(minutes, 'minute')
  if (minutes < 1440) return count(Math.floor(minutes / 60), 'hour')
  return count(Math.floor(minutes / 1440), 'day')
}

/** `4.2 KB`, `312 B`. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/**
 * The `enabled` map for turning one assistant on or off: everyone running the same profile moves
 * with it, since omp disables skills per profile.
 */
export function accessChange(
  assistants: readonly SkillAssistant[],
  profiles: Record<string, string | null>,
  id: string,
  on: boolean,
): Record<string, boolean> {
  const profile = profiles[id] ?? assistants.find((a) => a.id === id)?.profile ?? null
  const out: Record<string, boolean> = { [id]: on }
  if (profile === null) return out
  for (const a of assistants) {
    if ((profiles[a.id] ?? a.profile) === profile) out[a.id] = on
  }
  return out
}

/** Global: every assistant may load it. One: a single assistant (and its profile mates). */
export type SkillScope = { kind: 'global' } | { kind: 'one'; id: string }

/** The scope `usedBy` reads as; null when no assistant loads the skill. */
export function scopeOf(
  usedBy: readonly string[],
  assistants: readonly SkillAssistant[],
  profiles: Record<string, string | null>,
): SkillScope | null {
  const first = usedBy[0]
  if (first === undefined) return null
  const group = Object.keys(accessChange(assistants, profiles, first, true))
  const one =
    group.length < assistants.length &&
    usedBy.length === group.length &&
    usedBy.every((id) => group.includes(id))
  return one ? { kind: 'one', id: first } : { kind: 'global' }
}

/** The `enabled` map that gives the skill this scope. */
export function scopeAccess(
  scope: SkillScope,
  assistants: readonly SkillAssistant[],
  profiles: Record<string, string | null>,
): Record<string, boolean> {
  const all = Object.fromEntries(assistants.map((a) => [a.id, scope.kind === 'global']))
  return scope.kind === 'global'
    ? all
    : { ...all, ...accessChange(assistants, profiles, scope.id, true) }
}

/** Groups of two or more assistants that share a profile, as `[profile, titles]`. */
export function sharedProfiles(
  assistants: readonly SkillAssistant[],
  profiles: Record<string, string | null>,
): Array<[string, string[]]> {
  const by = new Map<string, string[]>()
  for (const a of assistants) {
    const p = profiles[a.id] ?? a.profile
    if (p === null) continue
    by.set(p, [...(by.get(p) ?? []), a.title])
  }
  return [...by].filter(([, titles]) => titles.length > 1)
}

/** `Nova and Polaris`, `Nova, Astra and Polaris`. */
export function joinTitles(titles: readonly string[]): string {
  if (titles.length < 2) return titles.join('')
  return `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`
}
