import { TERMINAL_TICKET_STATE_TYPES } from '@relay/protocol'
import {
  addDays,
  barOf,
  byPriority,
  dateOfDay,
  dayOfDate,
  ganttDates,
  milestoneOf,
  NO_PROJECT,
  type Bar,
  type Day,
  type DraftRow,
  type PlanTicket,
} from './plan-rules'

/**
 * The Timeline's rows (PLAN T7.2): project -> milestone -> open tickets by priority then order,
 * as SVAR tasks. Summary rows are computed here (start/end of their children) and are never
 * dragged. Tickets without a due date go to the "No date" list; milestone targets and today are
 * date lines drawn by Relay's own overlay (SVAR MIT ignores `markers`).
 */

/** A SVAR task (ITask-compatible). Ticket rows use the key as id. */
export interface TimelineTask {
  id: string
  text: string
  type: 'task' | 'summary'
  parent: string | 0
  start: Date
  end: Date
  progress: 0
  open?: true
  /** Ticket rows: the draft changes it. */
  draft?: true
  /** Ticket rows: places moved by the draft (positive: up). */
  delta?: number
}

export interface DateLine {
  id: string
  label: string
  kind: 'release' | 'today'
  /** The date it stands for. */
  day: Day
  /** The day whose start the line sits on (a target's line ends its day, like a bar due then). */
  at: Day
}

export interface NoDateItem {
  key: string
  title: string
  /** `Project / Milestone`. */
  group: string
}

/** One milestone (or "No milestone") of a project: its open tickets in order. */
export interface TimelineMilestone {
  id: string
  projectId: string | null
  milestoneId: string | null
  label: string
  keys: string[]
}

export interface TimelineModel {
  tasks: TimelineTask[]
  lines: DateLine[]
  noDate: NoDateItem[]
  /** Each dated ticket's bar as shown. */
  bars: Record<string, Bar>
  milestones: TimelineMilestone[]
  /** The chart's range. */
  start: Date
  end: Date
}

interface MilestoneGroup {
  id: string | null
  name: string
  sortOrder: number
  targetDate: Day | null
  tickets: PlanTicket[]
}

interface ProjectGroup {
  id: string | null
  name: string
  milestones: Map<string | null, MilestoneGroup>
}

function projectGroup(projects: Map<string | null, ProjectGroup>, t: PlanTicket): ProjectGroup {
  const pid = t.project?.id ?? null
  let p = projects.get(pid)
  if (!p) {
    p = { id: pid, name: t.project?.name ?? NO_PROJECT, milestones: new Map() }
    projects.set(pid, p)
  }
  return p
}

function milestoneGroup(p: ProjectGroup, t: PlanTicket): MilestoneGroup {
  const m = milestoneOf(t)
  let g = p.milestones.get(m.id)
  if (!g) {
    g = {
      ...m,
      sortOrder: t.milestone?.sortOrder ?? Infinity,
      targetDate: t.milestone?.targetDate ?? null,
      tickets: [],
    }
    p.milestones.set(m.id, g)
  }
  return g
}

function groupTickets(tickets: readonly PlanTicket[]): ProjectGroup[] {
  const projects = new Map<string | null, ProjectGroup>()
  for (const t of tickets) {
    if (TERMINAL_TICKET_STATE_TYPES[t.state.type]) continue
    milestoneGroup(projectGroup(projects, t), t).tickets.push(t)
  }
  return [...projects.values()].sort(
    (a, b) => Number(a.id === null) - Number(b.id === null) || a.name.localeCompare(b.name),
  )
}

/** Where each key sits after the draft's priority/order changes (by key). */
function draftOrder(
  tickets: readonly PlanTicket[],
  rows: readonly DraftRow[],
): Map<string, number> {
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const moved = tickets.map((t) => ({ ...t, ...pickOrder(byKey.get(t.key)) }))
  return new Map(moved.sort(byPriority).map((t, i) => [t.key, i]))
}

function pickOrder(r: DraftRow | undefined): Partial<PlanTicket> {
  const out: Partial<PlanTicket> = {}
  if (r?.priority !== undefined) out.priority = r.priority
  if (r?.prioritySortOrder !== undefined) out.prioritySortOrder = r.prioritySortOrder
  return out
}

function span(tasks: readonly Pick<TimelineTask, 'start' | 'end'>[]): { start: Date; end: Date } {
  return {
    start: new Date(Math.min(...tasks.map((t) => t.start.getTime()))),
    end: new Date(Math.max(...tasks.map((t) => t.end.getTime()))),
  }
}

/** The days the chart must show besides the bars: every date line and every date the draft proposes. */
function markedDays(model: TimelineModel, rows: readonly DraftRow[]): { start: Date; end: Date }[] {
  const proposed = rows.flatMap((r) => [r.dueDate, r.plannedStart])
  const days = [...model.lines.map((l) => l.at), ...proposed].filter(
    (d): d is Day => typeof d === 'string',
  )
  return days.map((d) => ganttDates({ start: d, end: d }))
}

interface Build {
  model: TimelineModel
  today: Day
  rows: readonly DraftRow[]
}

/** One milestone's ticket rows; its undated tickets go to the No date list. */
function addMilestone(
  b: Build,
  p: ProjectGroup,
  m: MilestoneGroup,
  groupStart: Day | null,
): TimelineTask[] {
  const sorted = [...m.tickets].sort(byPriority)
  const after = draftOrder(sorted, b.rows)
  const parent = `m:${p.id ?? ''}:${m.id ?? ''}`
  const out: TimelineTask[] = []
  let previousDue: Day | null = null
  sorted.forEach((t, i) => {
    const bar = barOf(t, { previousDue, groupStart, today: b.today })
    if (!bar) {
      b.model.noDate.push({ key: t.key, title: t.title, group: `${p.name} / ${m.name}` })
      return
    }
    previousDue = bar.end
    b.model.bars[t.key] = bar
    const delta = i - (after.get(t.key) ?? i)
    out.push({
      id: t.key,
      text: `${t.key} ${t.title}`,
      type: 'task',
      parent,
      ...ganttDates(bar),
      progress: 0,
      ...(b.rows.some((r) => r.key === t.key) ? { draft: true as const } : {}),
      ...(delta !== 0 ? { delta } : {}),
    })
  })
  b.model.milestones.push({
    id: parent,
    projectId: p.id,
    milestoneId: m.id,
    label: `${p.name} / ${m.name}`,
    keys: sorted.map((t) => t.key),
  })
  return out
}

function addProject(b: Build, p: ProjectGroup): void {
  const pid = `p:${p.id ?? ''}`
  const milestones = [...p.milestones.values()].sort((x, y) => x.sortOrder - y.sortOrder)
  const rows: TimelineTask[] = []
  let groupStart: Day | null = null
  for (const m of milestones) {
    const kids = addMilestone(b, p, m, groupStart)
    if (m.targetDate) {
      groupStart = m.targetDate
      b.model.lines.push({
        id: `m:${p.id ?? ''}:${m.id ?? ''}`,
        label: m.name,
        kind: 'release',
        day: m.targetDate,
        at: addDays(m.targetDate, 1),
      })
    }
    if (kids.length === 0) continue
    const text = m.targetDate ? `${m.name} (${m.targetDate})` : m.name
    const summary = { id: kids[0]!.parent as string, text, parent: pid, ...span(kids) }
    rows.push({ ...summary, type: 'summary', progress: 0, open: true }, ...kids)
  }
  if (rows.length === 0) return
  const head = { id: pid, text: p.name, parent: 0 as const, ...span(rows) }
  b.model.tasks.push({ ...head, type: 'summary', progress: 0, open: true }, ...rows)
}

/** The Timeline for `tickets` (done and canceled ones left out), with the draft's markers. */
export function buildTimeline(
  tickets: readonly PlanTicket[],
  today: Day,
  rows: readonly DraftRow[] = [],
): TimelineModel {
  const model: TimelineModel = {
    tasks: [],
    lines: [{ id: 'today', label: 'Today', kind: 'today', day: today, at: today }],
    noDate: [],
    bars: {},
    milestones: [],
    start: dateOfDay(addDays(today, -14)),
    end: dateOfDay(addDays(today, 60)),
  }
  const b: Build = { model, today, rows }
  for (const p of groupTickets(tickets)) addProject(b, p)
  const all = [...model.tasks, { start: model.start, end: model.end }, ...markedDays(model, rows)]
  const { start, end } = span(all)
  model.start = dateOfDay(addDays(dayOfDate(start), -7))
  model.end = dateOfDay(addDays(dayOfDate(end), 14))
  return model
}

/** A ghost bar: where a draft row puts a dated ticket. */
export interface GhostBar {
  key: string
  bar: Bar
  error?: string
}

/** Ghost bars for draft rows that move a shown ticket's dates; a cleared due date has none. */
export function ghostsOf(model: TimelineModel, rows: readonly DraftRow[]): GhostBar[] {
  const out: GhostBar[] = []
  for (const r of rows) {
    const shown = model.bars[r.key]
    if (!shown || r.dueDate === null) continue
    const end = r.dueDate ?? shown.end
    const start = r.plannedStart ?? shown.start
    if (start === shown.start && end === shown.end) continue
    out.push({ key: r.key, bar: { start: start > end ? end : start, end }, error: r.error })
  }
  return out
}
