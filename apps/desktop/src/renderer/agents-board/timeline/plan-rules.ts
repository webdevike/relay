import type { TicketBoardFacts, TicketPlanProposal, TicketPlanRow } from '@relay/protocol'

/**
 * Timeline semantics (PLAN T7.1), pure. Priority 1 Urgent ... 4 Low, 0 None sorts last; within a
 * priority Linear's `prioritySortOrder` orders (ascending). Dates are date-only `YYYY-MM-DD`
 * (Linear's TimelessDate, a local calendar day): arithmetic runs on UTC days, and the gantt gets
 * local-midnight Dates read back with local getters, so no time zone ever shifts a day. A bar
 * spans start ... due inclusive; the gantt's end is the day after due (exclusive end).
 */

/** A calendar day, `YYYY-MM-DD`. */
export type Day = string

export type PlanTicket = Pick<
  TicketBoardFacts,
  | 'key'
  | 'id'
  | 'title'
  | 'state'
  | 'priority'
  | 'prioritySortOrder'
  | 'dueDate'
  | 'plannedStart'
  | 'startedAt'
  | 'updatedAt'
  | 'project'
  | 'milestone'
>

export const PRIORITY_LABEL: readonly string[] = ['No priority', 'Urgent', 'High', 'Medium', 'Low']
export const NO_DATE = 'No date'
export const NO_MILESTONE = 'No milestone'
export const NO_PROJECT = 'No project'

/** Sort rank: Urgent (1) first, None (0) after Low (4). */
export function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority
}

type Ordered = Pick<PlanTicket, 'key' | 'priority' | 'prioritySortOrder'>

/** Priority, then the order within it, then key (stable). */
export function byPriority(a: Ordered, b: Ordered): number {
  return (
    priorityRank(a.priority) - priorityRank(b.priority) ||
    a.prioritySortOrder - b.prioritySortOrder ||
    a.key.localeCompare(b.key)
  )
}

const pad = (n: number): string => String(n).padStart(2, '0')
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

/** The local calendar day of a Date (the gantt's dates are local). */
export function dayOfDate(d: Date): Day {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The local calendar day of a timestamp (`startedAt`, now). */
export function dayOfMs(ms: number): Day {
  return dayOfDate(new Date(ms))
}

function parts(day: Day): [number, number, number] {
  const m = DAY_RE.exec(day)
  if (!m) throw new Error(`Not a date: ${day}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** A real calendar day in `YYYY-MM-DD` (not 2026-02-30). */
export function isDay(s: string): boolean {
  if (!DAY_RE.test(s)) return false
  const [y, m, d] = parts(s)
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

/** The gantt's Date for a day: its local midnight. */
export function dateOfDay(day: Day): Date {
  const [y, m, d] = parts(day)
  return new Date(y, m - 1, d)
}

export function addDays(day: Day, n: number): Day {
  const [y, m, d] = parts(day)
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS)
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** A bar: start and due, both inclusive days, start <= end. */
export interface Bar {
  start: Day
  end: Day
}

/** The gantt's dates for a bar (end exclusive: the day after due). */
export function ganttDates(bar: Bar): { start: Date; end: Date } {
  return { start: dateOfDay(bar.start), end: dateOfDay(addDays(bar.end, 1)) }
}

/** A bar from the gantt's dates; an end at or before the start keeps one day. */
export function barOfGantt(start: Date, end: Date): Bar {
  const s = dayOfDate(start)
  const e = addDays(dayOfDate(end), -1)
  return { start: s, end: e < s ? s : e }
}

export interface StartContext {
  /** Due date of the previous dated row in the milestone. */
  previousDue: Day | null
  /** When the milestone (or project) starts, when known. */
  groupStart: Day | null
  today: Day
}

/** plannedStart ?? startedAt's day ?? previous row's due ?? milestone/project start ?? today. */
export function startOf(t: Pick<PlanTicket, 'plannedStart' | 'startedAt'>, ctx: StartContext): Day {
  const started = t.startedAt === null ? null : dayOfMs(t.startedAt)
  return t.plannedStart ?? started ?? ctx.previousDue ?? ctx.groupStart ?? ctx.today
}

/** The bar for a ticket; null when it has no due date (it goes to "No date"). End >= start. */
export function barOf(
  t: Pick<PlanTicket, 'plannedStart' | 'startedAt' | 'dueDate'>,
  ctx: StartContext,
): Bar | null {
  if (!t.dueDate) return null
  const start = startOf(t, ctx)
  return { start: start > t.dueDate ? t.dueDate : start, end: t.dueDate }
}

/** The milestone group a ticket sits under. */
export function milestoneOf(t: Pick<PlanTicket, 'milestone'>): {
  id: string | null
  name: string
} {
  return t.milestone
    ? { id: t.milestone.id, name: t.milestone.name }
    : { id: null, name: NO_MILESTONE }
}

/** Fields a draft row may change. `plannedStart` is Relay-only (never written to Linear). */
export interface PlanFields {
  dueDate: Day | null
  priority: number
  prioritySortOrder: number
  plannedStart: Day | null
}
export type PlanField = keyof PlanFields
export const PLAN_FIELDS: readonly PlanField[] = [
  'dueDate',
  'priority',
  'prioritySortOrder',
  'plannedStart',
]
const LINEAR_FIELDS: readonly PlanField[] = ['dueDate', 'priority', 'prioritySortOrder']

/** A drag's change: a move shifts start and due, a start-only resize is Relay-only. */
export function dragEdit(before: Bar, after: Bar): Partial<PlanFields> {
  const startMoved = before.start !== after.start
  const endMoved = before.end !== after.end
  const end = after.end < after.start ? after.start : after.end
  if (startMoved && endMoved) return { plannedStart: after.start, dueDate: end }
  if (startMoved) return { plannedStart: after.start > before.end ? before.end : after.start }
  if (endMoved) return { dueDate: end < before.start ? before.start : end }
  return {}
}

function targetPriority(own: number, before: Ordered | null, after: Ordered | null): number {
  const rank = priorityRank(own)
  if (before && priorityRank(before.priority) > rank) return before.priority
  if (after && priorityRank(after.priority) < rank) return after.priority
  return own
}

function orderBetween(lo: number | null, hi: number | null, own: number): number {
  if (lo !== null && hi !== null) return (lo + hi) / 2
  if (lo !== null) return lo + 1
  if (hi !== null) return hi - 1
  return own
}

/**
 * Where a row dropped at `index` of `rest` (the milestone's rows in order, without it) lands.
 * Within its priority: the midpoint of its neighbors' orders. Dropped among another priority: that
 * priority, at the boundary of the group (bottom when moved down, top when moved up).
 */
export function placeAt(
  moved: Ordered,
  rest: readonly Ordered[],
  index: number,
): Pick<PlanFields, 'priority' | 'prioritySortOrder'> {
  const before = rest[index - 1] ?? null
  const after = rest[index] ?? null
  const priority = targetPriority(moved.priority, before, after)
  const lo = before?.priority === priority ? before.prioritySortOrder : null
  const hi = after?.priority === priority ? after.prioritySortOrder : null
  return { priority, prioritySortOrder: orderBetween(lo, hi, moved.prioritySortOrder) }
}

/** One ticket's pending change: only fields that differ from `base` are set. */
export type DraftRow = Partial<PlanFields> & {
  key: string
  issueId: string
  /** The row's own write id, minted once; every retry reuses it. */
  opId: string
  /** The ticket's `updatedAt` the draft was made from. */
  baseUpdatedAt: number
  /** The ticket's values the draft was made from. */
  base: PlanFields
  /** Astra's reason for it. */
  reason?: string
  /** Why its write failed (kept until a retry or edit). */
  error?: string
  /** The ticket changed since the draft was made. */
  stale?: boolean
}

export function baseOf(t: PlanTicket): PlanFields {
  return {
    dueDate: t.dueDate,
    priority: t.priority,
    prioritySortOrder: t.prioritySortOrder,
    plannedStart: t.plannedStart ?? null,
  }
}

/** Drops fields equal to the base. */
function prune(row: DraftRow): DraftRow {
  const out: DraftRow = { ...row }
  for (const f of PLAN_FIELDS) if (out[f] === undefined || out[f] === row.base[f]) delete out[f]
  return out
}

export function hasChanges(row: DraftRow): boolean {
  return PLAN_FIELDS.some((f) => row[f] !== undefined)
}

/** The draft with `patch` merged into the ticket's row (new rows mint an opId once). */
export function editRows(
  rows: readonly DraftRow[],
  t: PlanTicket,
  patch: Partial<PlanFields> & { reason?: string },
  mint: () => string,
): DraftRow[] {
  const current = rows.find((r) => r.key === t.key)
  const fresh: DraftRow = {
    key: t.key,
    issueId: t.id,
    opId: mint(),
    baseUpdatedAt: t.updatedAt,
    base: baseOf(t),
  }
  const row = prune({ ...(current ?? fresh), ...patch })
  delete row.error
  const others = rows.filter((r) => r.key !== t.key)
  if (!hasChanges(row)) return others
  return current ? rows.map((r) => (r.key === t.key ? row : r)) : [...rows, row]
}

/** Draft rows from Astra's proposal; keys outside `tickets` (the scope at the baseline) are dropped. */
export function proposalRows(
  proposal: TicketPlanProposal,
  tickets: readonly PlanTicket[],
  mint: () => string,
): DraftRow[] {
  let rows: DraftRow[] = []
  for (const c of proposal.changes) {
    const t = tickets.find((x) => x.key === c.key)
    if (!t || !validDates(c.start ?? null, c.dueDate ?? null)) continue
    const patch: Partial<PlanFields> & { reason: string } = { reason: c.reason }
    if (c.dueDate !== undefined) patch.dueDate = c.dueDate
    if (c.start !== undefined) patch.plannedStart = c.start
    if (c.priority !== undefined) patch.priority = c.priority
    if (c.prioritySortOrder !== undefined) patch.prioritySortOrder = c.prioritySortOrder
    rows = editRows(rows, t, patch, mint)
  }
  return rows
}

/** Keys whose ticket changed (or left the board) since the draft was made. */
export function staleKeys(rows: readonly DraftRow[], tickets: readonly PlanTicket[]): string[] {
  const now = new Map(tickets.map((t) => [t.key, t.updatedAt]))
  return rows.filter((r) => now.get(r.key) !== r.baseUpdatedAt).map((r) => r.key)
}

/** Both real days (or absent), and the start not after the due date. */
export function validDates(start: Day | null, due: Day | null): boolean {
  if (start !== null && !isDay(start)) return false
  if (due !== null && !isDay(due)) return false
  return start === null || due === null || start <= due
}

/** The draft re-based on the tickets as they are now (reconfirm after stale); no-op rows drop. */
export function rebaseRows(rows: readonly DraftRow[], tickets: readonly PlanTicket[]): DraftRow[] {
  const out: DraftRow[] = []
  for (const r of rows) {
    const t = tickets.find((x) => x.key === r.key)
    if (!t) continue
    const row = prune({ ...r, baseUpdatedAt: t.updatedAt, base: baseOf(t) })
    delete row.stale
    delete row.error
    if (hasChanges(row)) out.push(row)
  }
  return out
}

/** A row with only a start change is Relay-only: saved on Apply, nothing written to Linear. */
export function isRelayOnly(row: DraftRow): boolean {
  return !LINEAR_FIELDS.some((f) => row[f] !== undefined)
}

export function splitRows(rows: readonly DraftRow[]): {
  linear: DraftRow[]
  relayOnly: DraftRow[]
} {
  return { linear: rows.filter((r) => !isRelayOnly(r)), relayOnly: rows.filter(isRelayOnly) }
}

/** The row as an `applyPlan` write. */
export function toPlanRow(row: DraftRow): TicketPlanRow {
  const out: TicketPlanRow = {
    key: row.key,
    issueId: row.issueId,
    opId: row.opId,
    baseUpdatedAt: row.baseUpdatedAt,
  }
  for (const f of PLAN_FIELDS) if (row[f] !== undefined) Object.assign(out, { [f]: row[f] })
  return out
}

export interface PlanChange {
  key: string
  field: string
  from: string
  to: string
}

const FIELD_LABEL: Record<PlanField, string> = {
  dueDate: 'Due date',
  priority: 'Priority',
  prioritySortOrder: 'Order',
  plannedStart: 'Start (Relay only)',
}

function fieldText(f: PlanField, v: PlanFields[PlanField]): string {
  if (v === null) return 'none'
  if (f === 'priority') return PRIORITY_LABEL[v as number] ?? String(v)
  if (f === 'prioritySortOrder') return String(Math.round((v as number) * 100) / 100)
  return String(v)
}

/** Every change of the draft, for the Apply confirm: key, field, old -> new. */
export function changesOf(rows: readonly DraftRow[]): PlanChange[] {
  const out: PlanChange[] = []
  for (const r of rows) {
    for (const f of PLAN_FIELDS) {
      const to = r[f]
      if (to === undefined) continue
      out.push({
        key: r.key,
        field: FIELD_LABEL[f],
        from: fieldText(f, r.base[f]),
        to: fieldText(f, to),
      })
    }
  }
  return out
}
