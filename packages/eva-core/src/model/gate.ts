// Pure presentation rules ported from gate.rs and habits_view.rs. No fs.
import { addDays, localDate } from './dates'

export const MAX_MINUTES = 600
export const HISTORY_ROWS = 30

export interface GateHabit {
  id: string
  name: string
  minutes: number
  photo: boolean
}
export interface GateTask {
  id: string
  name: string
  minutes: number | null
  done: boolean
}
export interface GateHistory {
  kind: 'habit' | 'task' | 'override' | ''
  id: string
  name: string
  startedAt: string | null
  doneAt: string
  photo: string | null
  override: string | null
}
export interface GatePlan {
  date: string
  breaks: Array<{ at: string; done: boolean }>
  source: string
}
export interface GateActive {
  kind: string
  id: string
  startedAt: string
  endsAt: string
}
export interface GateStatusLike {
  locked: boolean
  lockedAt: string | null
  reason: string | null
  active: GateActive | null
  plan: GatePlan | null
  history: GateHistory[]
  habits: GateHabit[]
  tasks: GateTask[]
  canFinish: boolean
  remainingSeconds: number
  blocked: boolean
}

function parseTime(text: string | null | undefined): number | null {
  if (!text) return null
  const t = Date.parse(text)
  return Number.isNaN(t) ? null : t
}

function localDayOf(text: string | null | undefined): string | null {
  const t = parseTime(text)
  return t === null ? null : localDate(new Date(t))
}

/** Consecutive local days with a finished (not overridden) entry; today or, while open, yesterday. */
export function streak(history: readonly GateHistory[], id: string, today: string): number {
  const days = new Set<string>()
  for (const e of history) {
    if (e.id !== id || e.kind === 'override' || e.override !== null) continue
    const d = localDayOf(e.doneAt)
    if (d) days.add(d)
  }
  let day = days.has(today) ? today : addDays(today, -1)
  let count = 0
  while (days.has(day)) {
    count += 1
    day = addDays(day, -1)
  }
  return count
}

export type BreakState = 'done' | 'due' | 'upcoming'
export interface BreakRow {
  at: string
  state: BreakState
}

/** Today's breaks: none when the plan is for another local day. */
export function todaysBreaks(plan: GatePlan | null, now: Date): BreakRow[] {
  if (!plan || plan.date !== localDate(now)) return []
  const n = now.getTime()
  return plan.breaks.map((b) => {
    const at = parseTime(b.at)
    const state: BreakState = b.done ? 'done' : at !== null && at <= n ? 'due' : 'upcoming'
    return { at: b.at, state }
  })
}

export function planSourceLabel(source: string): string {
  if (source === 'calendar') return 'From your calendar'
  if (source === 'fallback') return 'Evenly spaced (calendar unavailable)'
  return 'Planned'
}

/** The first upcoming break of today's plan, or null. */
export function nextBreakAt(plan: GatePlan | null, now: Date): string | null {
  return todaysBreaks(plan, now).find((b) => b.state === 'upcoming')?.at ?? null
}

/** m:ss, h:mm:ss from one hour; negative clamps to 0:00. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor(s / 60) % 60
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export interface HistoryRow {
  entry: GateHistory
  name: string
  minutes: number | null
  label: string
  overridden: boolean
}

export function historyRows(history: readonly GateHistory[]): HistoryRow[] {
  const key = (e: GateHistory): number => parseTime(e.doneAt) ?? Number.NEGATIVE_INFINITY
  return [...history]
    .sort((a, b) => key(b) - key(a))
    .slice(0, HISTORY_ROWS)
    .map((entry) => {
      const start = parseTime(entry.startedAt)
      const end = parseTime(entry.doneAt)
      const minutes =
        start !== null && end !== null ? Math.max(0, Math.round((end - start) / 60000)) : null
      const overridden = entry.override !== null
      const label = overridden
        ? `Overridden: ${entry.override}`
        : minutes !== null
          ? `${minutes} min`
          : ''
      return { entry, name: entry.name === '' ? entry.id : entry.name, minutes, label, overridden }
    })
}

export interface PickItem {
  id: string
  name: string
  meta: string
  photo: boolean
  kind: 'habit' | 'task'
}

/** Overlay picker: habits, then open tasks. */
export function pickItems(habits: readonly GateHabit[], tasks: readonly GateTask[]): PickItem[] {
  return [
    ...habits.map((h): PickItem => ({
      id: h.id,
      name: h.name,
      meta: `${h.minutes} min`,
      photo: h.photo,
      kind: 'habit',
    })),
    ...tasks
      .filter((t) => !t.done)
      .map((t): PickItem => ({
        id: t.id,
        name: t.name,
        meta: t.minutes === null ? 'Task' : `Task, ${t.minutes} min`,
        photo: false,
        kind: 'task',
      })),
  ]
}
