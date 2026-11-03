import { addDays, daysBetween, isoWeekStart, shortDate, parseDay } from './dates'
import type { JournalEntry } from './journal'
import { aliasesFor } from './tags'
import type { OpenTodo } from './todos'
import {
  dailyActivity,
  sortWorkspaces,
  timeline,
  withBuiltIn,
  workspaceFrom,
  type Section,
  type TimelineItem,
  type Workspace,
  type WorkspaceFile,
} from './workspaces'

export type FilterId = 'all' | 'active' | 'todos' | 'quiet'

export interface WorkspaceSummary {
  id: string
  name: string
  displayName: string
  tagline: string | null
  latest: string | null
  lastActive: string | null
  openTodos: number
  builtIn: boolean
  hasFile: boolean
  aliases: string[]
  /** Length 90, oldest first. */
  daily: number[]
}
export interface DashboardPayload {
  today: string
  generatedAt: number
  workspaces: WorkspaceSummary[]
  todos: OpenTodo[]
  updates7d: number
}
export interface WorkspaceDetailPayload {
  today: string
  workspace: WorkspaceSummary | null
  timeline: TimelineItem[]
  todos: OpenTodo[]
  sections: Section[]
}
export interface ActivityRow {
  date: string
  tick: string
  count: number
  inWeek: boolean
  isToday: boolean
}

const ACTIVE_DAYS = 14
const QUIET_DAYS = 30

/** Port of dashboard.rs Filter::admits. */
export function matchesFilter(
  ws: { lastActive: string | null; openTodos: number },
  filter: FilterId,
  today: string,
): boolean {
  const age = ws.lastActive === null ? null : daysBetween(ws.lastActive, today)
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return age !== null && age <= ACTIVE_DAYS
    case 'todos':
      return ws.openTodos > 0
    case 'quiet':
      return age === null || age > QUIET_DAYS
  }
}

export function filterCounts(
  list: { lastActive: string | null; openTodos: number }[],
  today: string,
): Record<FilterId, number> {
  const ids: FilterId[] = ['all', 'active', 'todos', 'quiet']
  const out = { all: 0, active: 0, todos: 0, quiet: 0 }
  for (const id of ids) out[id] = list.filter((w) => matchesFilter(w, id, today)).length
  return out
}

/** Recent = first two of the filtered list; the grid shows the rest. */
export function splitRecent<T>(list: T[]): { recent: T[]; rest: T[] } {
  return { recent: list.slice(0, 2), rest: list.slice(2) }
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export function summaryLine(workspaces: number, todos: number, updates: number): string {
  return `${plural(workspaces, 'workspace', 'workspaces')}, ${plural(todos, 'open todo', 'open todos')}, ${plural(updates, 'update', 'updates')} this week`
}

export function toSummary(ws: Workspace, today: string): WorkspaceSummary {
  return {
    id: ws.id,
    name: ws.name,
    displayName: ws.displayName,
    tagline: ws.tagline,
    latest: ws.latest,
    lastActive: ws.lastActive,
    openTodos: ws.openTodos,
    builtIn: ws.builtIn,
    hasFile: ws.path !== null,
    aliases: aliasesFor(ws.id),
    daily: dailyActivity(ws.activity, today, 90),
  }
}

function buildWorkspaces(
  files: WorkspaceFile[],
  journal: JournalEntry[],
  todos: OpenTodo[],
): Workspace[] {
  const tags = todos.map((t) => t.tag)
  return sortWorkspaces(withBuiltIn(files).map((f) => workspaceFrom(f, journal, tags)))
}

export function buildDashboard(
  files: WorkspaceFile[],
  journal: JournalEntry[],
  todos: OpenTodo[],
  today: string,
  nowMs: number,
): DashboardPayload {
  const since = addDays(today, -7)
  return {
    today,
    generatedAt: nowMs,
    workspaces: buildWorkspaces(files, journal, todos).map((w) => toSummary(w, today)),
    todos,
    updates7d: journal.filter((e) => e.date >= since).length,
  }
}

export function buildWorkspaceDetail(
  files: WorkspaceFile[],
  journal: JournalEntry[],
  todos: OpenTodo[],
  id: string,
  today: string,
): WorkspaceDetailPayload {
  const ws = buildWorkspaces(files, journal, todos).find((w) => w.id === id)
  if (!ws) return { today, workspace: null, timeline: [], todos: [], sections: [] }
  return {
    today,
    workspace: toSummary(ws, today),
    timeline: timeline(ws, journal),
    todos: todos.filter((t) => t.tag === id),
    sections: ws.sections,
  }
}

const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** Rows for the last `range` entries of a 90 day array; shape matches renderer ui/ActivityChart. */
export function activityRows(daily: number[], range: 7 | 30 | 90, today: string): ActivityRow[] {
  const slice = daily.slice(-range)
  const weekStart = isoWeekStart(today)
  return slice.map((count, i) => {
    const date = addDays(today, -(slice.length - 1 - i))
    const dow = parseDay(date)!.getDay()
    let tick = ''
    if (range === 7) tick = WEEKDAY[dow]!
    else if (dow === 1) tick = shortDate(date)
    return {
      date,
      tick,
      count,
      inWeek: date >= weekStart && date <= today,
      isToday: date === today,
    }
  })
}
