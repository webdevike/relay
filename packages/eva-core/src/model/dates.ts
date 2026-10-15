const DAY_MS = 86_400_000
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Local YYYY-MM-DD of a Date. */
export function localDate(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0')
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Strict YYYY-MM-DD to a local-midnight Date, or null when malformed or not a real day. */
export function parseDay(s: string): Date | null {
  const m = DAY_RE.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return date
}

function utcDay(s: string): number {
  const m = DAY_RE.exec(s)
  if (!m) return NaN
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). DST safe. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcDay(to) - utcDay(from)) / DAY_MS)
}

export function addDays(day: string, n: number): string {
  const t = new Date(utcDay(day) + n * DAY_MS)
  const y = String(t.getUTCFullYear()).padStart(4, '0')
  const m = String(t.getUTCMonth() + 1).padStart(2, '0')
  const d = String(t.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Monday of the ISO week containing `day`. */
export function isoWeekStart(day: string): string {
  const dow = new Date(utcDay(day)).getUTCDay() // 0 = Sunday
  return addDays(day, -((dow + 6) % 7))
}

/** EVAOS_NOW shifts time by a fixed offset; time keeps moving. */
export function makeClock(
  nowIso: string | null,
  base: () => number = Date.now,
): { now(): Date; today(): string } {
  const parsed = nowIso ? Date.parse(nowIso) : NaN
  const offset = Number.isNaN(parsed) ? 0 : parsed - base()
  const now = (): Date => new Date(base() + offset)
  return { now, today: () => localDate(now()) }
}

const SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

/** `Oct 1` style. */
export function shortDate(day: string): string {
  const d = parseDay(day)
  return d ? SHORT.format(d) : day
}

/** Port of dashboard.rs relative. */
export function relativeLabel(date: string | null, today: string): string {
  if (date === null) return 'No activity'
  const n = daysBetween(date, today)
  if (n <= 0) return 'Today'
  if (n === 1) return 'Yesterday'
  if (n <= 13) return `${n}d ago`
  return shortDate(date)
}

/** Port of dashboard.rs active_since. */
export function activeSince(date: string | null, today: string): string {
  if (date === null) return 'never'
  const rel = relativeLabel(date, today)
  return daysBetween(date, today) <= 1 ? rel.toLowerCase() : rel
}
