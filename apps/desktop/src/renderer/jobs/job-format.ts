export interface NextDue {
  text: string
  tone: 'normal' | 'dim' | 'warning'
}

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Next due cell: absolute local times, with Not scheduled, Due now and Overdue states. */
export function formatNextDue(
  nextDueAt: number | null,
  enabled: boolean,
  every: string | null,
  now: Date,
): NextDue {
  if (!enabled || nextDueAt === null || !every) return { text: 'Not scheduled', tone: 'dim' }
  if (nextDueAt === 0) return { text: 'Due now', tone: 'warning' }
  if (nextDueAt <= now.getTime()) return { text: 'Overdue', tone: 'warning' }
  const at = new Date(nextDueAt)
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000)
  const time = TIME.format(at)
  if (days === 0) return { text: `Today ${time}`, tone: 'normal' }
  if (days === 1) return { text: `Tomorrow ${time}`, tone: 'normal' }
  return { text: `${DATE.format(at)}, ${time}`, tone: 'normal' }
}
