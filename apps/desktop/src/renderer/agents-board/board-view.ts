import { AGENT_COLUMNS, type AgentCard, type AgentColumn } from '@evaos/contract'

export const COLUMN_TITLE: Record<AgentColumn, string> = {
  queued: 'Queued',
  working: 'Working',
  needs: 'Needs Isaac',
  review: 'In review',
  qa: 'Merged/QA',
  done: 'Done',
}

export type GroupBy = 'none' | 'agent' | 'workspace'

export interface BoardFilters {
  query: string
  /** An agent's name, or null for all. */
  agent: string | null
  workspace: string | null
  showStale: boolean
  group: GroupBy
}

export const DEFAULT_FILTERS: BoardFilters = {
  query: '',
  agent: null,
  workspace: null,
  showStale: false,
  group: 'none',
}

/** The cards the filters keep: by agent, workspace, staleness and words in key, title or session. */
export function visibleCards(cards: readonly AgentCard[], f: BoardFilters): AgentCard[] {
  const words = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return cards.filter((c) => {
    if (!f.showStale && c.stale) return false
    if (f.agent !== null && c.agent !== f.agent) return false
    if (f.workspace !== null && c.workspace !== f.workspace) return false
    if (words.length === 0) return true
    const text = [c.key, c.title, c.session, c.agent, c.pill.label, c.pr ? `#${c.pr.number}` : null]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

/** Cards per column, in column order (each column keeps the newest activity first). */
export function byColumn(cards: readonly AgentCard[]): Record<AgentColumn, AgentCard[]> {
  const out = Object.fromEntries(AGENT_COLUMNS.map((c) => [c, [] as AgentCard[]])) as Record<
    AgentColumn,
    AgentCard[]
  >
  for (const c of cards) out[c.column].push(c)
  return out
}

export interface Lane {
  id: string
  title: string
  cards: AgentCard[]
}

/** Swimlanes for the chosen grouping; one unnamed lane without grouping. Lanes with no name go last. */
export function lanesOf(cards: readonly AgentCard[], group: GroupBy): Lane[] {
  if (group === 'none') return [{ id: 'all', title: '', cards: [...cards] }]
  const none = group === 'agent' ? 'No agent' : 'No workspace'
  const lanes = new Map<string, AgentCard[]>()
  for (const c of cards) {
    const name = (group === 'agent' ? c.agent : c.workspace) ?? none
    lanes.set(name, [...(lanes.get(name) ?? []), c])
  }
  return [...lanes.entries()]
    .sort(([a, x], [b, y]) =>
      a === none ? 1 : b === none ? -1 : y.length - x.length || a.localeCompare(b),
    )
    .map(([title, list]) => ({ id: title, title, cards: list }))
}

/** The distinct values a filter can pick from, most cards first. */
export function optionsOf(cards: readonly AgentCard[], field: 'agent' | 'workspace'): string[] {
  const n = new Map<string, number>()
  for (const c of cards) {
    const v = c[field]
    if (v) n.set(v, (n.get(v) ?? 0) + 1)
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v)
}

/** How long ago, compact: `now`, `6m`, `3h`, `2d`, `5w`. */
export function agoLabel(at: number | null, now: number): string {
  if (at === null) return ''
  const min = Math.floor(Math.max(0, now - at) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return d < 14 ? `${d}d` : `${Math.floor(d / 7)}w`
}
