import type { UsageAccount, UsageProvider, UsageWindow } from '@evaos/contract'

export const PROVIDER_NAME: Record<UsageProvider, string> = {
  anthropic: 'Claude',
  'openai-codex': 'Codex',
}

/** `none`: no data. `normal` below 70%, `warn` 70 to 89%, `danger` 90% and up or any limited window. */
export type UsageLevel = 'none' | 'normal' | 'warn' | 'danger'

export const percent = (w: UsageWindow): number => Math.round(w.usedFraction * 100)

/** The window closest to its limit; the first one on a tie. Null when there is none. */
export function mostUsed(windows: readonly UsageWindow[]): UsageWindow | null {
  let top: UsageWindow | null = null
  for (const w of windows) if (!top || w.usedFraction > top.usedFraction) top = w
  return top
}

/** A limited window is `danger` whatever its percent. */
export function windowLevel(w: UsageWindow): UsageLevel {
  if (w.status !== 'ok') return 'danger'
  const pct = percent(w)
  return pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : 'normal'
}

/** The level of the account's most-used window; `danger` when any window is limited. */
export function usageLevel(account: UsageAccount): UsageLevel {
  const top = mostUsed(account.windows)
  if (!top) return 'none'
  return account.windows.some((w) => w.status !== 'ok') ? 'danger' : windowLevel(top)
}

/** Mantine color for the ring or bar at a level. */
export const LEVEL_COLOR: Record<UsageLevel, string> = {
  none: 'var(--mantine-color-dimmed)',
  normal: 'var(--mantine-color-dimmed)',
  warn: 'yellow',
  danger: 'red',
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** `resets in 42m`, `resets in 3h 5m`, then `resets Sat 9:00 AM` from a day out. */
export function resetLabel(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return 'no reset time'
  const left = resetsAt - now
  if (left <= 0) return 'resets now'
  if (left < HOUR) return `resets in ${Math.max(1, Math.floor(left / MIN))}m`
  if (left < DAY) return `resets in ${Math.floor(left / HOUR)}h ${Math.floor((left % HOUR) / MIN)}m`
  const at = new Date(resetsAt).toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `resets ${at.replace(',', '')}`
}

/** The tooltip and popover reset text; limited windows say so first. */
export const windowReset = (w: UsageWindow, now: number): string =>
  w.status === 'ok' ? resetLabel(w.resetsAt, now) : `limited, ${resetLabel(w.resetsAt, now)}`

/** `just now`, `4 min ago`, `2 h ago`, `3 days ago`. */
export function agoLabel(at: number, now: number): string {
  const since = Math.max(0, now - at)
  if (since < MIN) return 'just now'
  if (since < HOUR) return `${Math.floor(since / MIN)} min ago`
  if (since < DAY) return `${Math.floor(since / HOUR)} h ago`
  const days = Math.floor(since / DAY)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}
