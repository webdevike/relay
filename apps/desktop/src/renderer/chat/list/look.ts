/**
 * How the chat list looks, ported from the native app's chat_view/look.rs: status and pill text,
 * ages, the bright rule, fast-settle, the split into Pinned / list / Snoozed / Settled, workspace
 * folders with their hint, project badges, the work line and the model name. Pure: callers pass
 * the clock, so the list ticks by re-rendering with a new `now`.
 */
import type { ChatRow } from '@evaos/contract'

/** How long a read, idle chat stays listed before it settles (native FAST_SETTLE). */
export const FAST_SETTLE_MS = 4 * 3600_000

/** Rows a workspace folder shows before `Show N more` (native FOLDER_SHOWN). */
export const FOLDER_SHOWN = 10

export type LookStatus =
  | 'working'
  | 'approval'
  | 'asked'
  | 'monitoring'
  | 'failed'
  | 'woke'
  | 'done'

/** Waiting on Isaac: an approval or a question. */
export const needsYou = (r: ChatRow): boolean =>
  r.status === 'needs-approval' || r.status === 'has-question'

/** Opened at or after its return (native order::is_read). */
export const isRead = (r: ChatRow): boolean => r.openedMs !== null && r.openedMs >= r.returnedMs

export const isWoke = (r: ChatRow): boolean => r.wokeMs !== null

export const isSnoozed = (r: ChatRow): boolean => r.snoozedUntilMs !== null

/** Running and not needing Isaac: replying, or mid-run (native sections::working). */
export const isWorking = (r: ChatRow): boolean =>
  r.running && !needsYou(r) && (r.status === 'working' || r.startedMs !== null)

/** What the row's status icon says (native look::status). */
export function lookStatus(r: ChatRow): LookStatus | null {
  if (r.status === 'needs-approval') return 'approval'
  if (r.status === 'has-question') return 'asked'
  const unread = !isRead(r)
  const monitoring = r.jobs > 0
  if (r.failed && unread) return 'failed'
  if (r.status === 'working' || (isWorking(r) && !monitoring)) return 'working'
  if (monitoring && r.running) return 'monitoring'
  if (isWoke(r)) return 'woke'
  if (unread) return 'done'
  return null
}

/** How long a run has gone: "4s", "2m", "1h". */
export function elapsed(sinceMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - sinceMs) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  return `${Math.floor(secs / 3600)}h`
}

/** How long ago: "now" under a minute, then "9m", "21h", "3d". */
export function age(thenMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - thenMs) / 1000))
  if (secs < 60) return 'now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h`
  return `${Math.floor(secs / 86_400)}d`
}

/** When the current run started: its run start, else its return time. */
export const runStart = (r: ChatRow): number => r.startedMs ?? r.returnedMs

/** The status pill's text (native look::pill). */
export function pill(status: LookStatus, startedMs: number, nowMs: number): string {
  switch (status) {
    case 'working':
      return `Working ${elapsed(startedMs, nowMs)}`
    case 'approval':
      return 'Approval'
    case 'asked':
      return 'Input'
    case 'monitoring':
      return 'Monitoring'
    case 'failed':
      return 'Failed'
    case 'woke':
      return 'Woke'
    case 'done':
      return 'Done'
  }
}

/** The title is drawn bright: the chat needs Isaac, came back unread, or woke. */
export const bright = (r: ChatRow): boolean => needsYou(r) || !isRead(r) || isWoke(r)

/**
 * A chat that settles without being archived: read, not working, not needing Isaac, not pinned,
 * woke or snoozed, and idle for FAST_SETTLE since it returned or was last unsettled.
 */
export function fastSettles(r: ChatRow, nowMs: number): boolean {
  const last = Math.max(r.returnedMs, r.keptMs ?? r.returnedMs)
  return (
    isRead(r) &&
    !isWorking(r) &&
    !needsYou(r) &&
    !r.pinned &&
    !isWoke(r) &&
    !isSnoozed(r) &&
    nowMs - last >= FAST_SETTLE_MS
  )
}

/** Archived by hand or auto-settle, or fast-settled. */
export const isSettled = (r: ChatRow, nowMs: number): boolean => r.archived || fastSettles(r, nowMs)

export interface Lists {
  pinned: ChatRow[]
  list: ChatRow[]
  snoozed: ChatRow[]
  settled: ChatRow[]
}

const byReturn = (a: ChatRow, b: ChatRow): number => b.returnedMs - a.returnedMs

/**
 * Pinned in the order given; the rest newest return first; snoozed soonest wake first; settled
 * (archived or fast-settled) newest return first (native look::split).
 */
export function split(rows: readonly ChatRow[], nowMs: number): Lists {
  const out: Lists = { pinned: [], list: [], snoozed: [], settled: [] }
  for (const r of rows) {
    if (isSettled(r, nowMs)) out.settled.push(r)
    else if (isSnoozed(r)) out.snoozed.push(r)
    else if (r.pinned) out.pinned.push(r)
    else out.list.push(r)
  }
  out.list.sort(byReturn)
  out.settled.sort(byReturn)
  out.snoozed.sort((a, b) => (a.snoozedUntilMs ?? 0) - (b.snoozedUntilMs ?? 0))
  return out
}

export interface Folder {
  name: string
  rows: ChatRow[]
  hint: LookStatus | null
}

const HINT_RANK: Record<LookStatus, number> = {
  approval: 0,
  asked: 1,
  failed: 2,
  working: 3,
  monitoring: 4,
  woke: 5,
  done: 6,
}

/** What a folder header signals: the most urgent status among its chats. */
export function hint(rows: readonly ChatRow[]): LookStatus | null {
  let best: LookStatus | null = null
  for (const r of rows) {
    const s = lookStatus(r)
    if (s !== null && (best === null || HINT_RANK[s] < HINT_RANK[best])) best = s
  }
  return best
}

/**
 * One folder per category, chats newest return first, the folder holding the newest return on
 * top (native look::folders).
 */
export function folders(list: readonly ChatRow[], categoryOf: (r: ChatRow) => string): Folder[] {
  const byName = new Map<string, ChatRow[]>()
  for (const r of list) {
    const name = categoryOf(r)
    const rows = byName.get(name)
    if (rows) rows.push(r)
    else byName.set(name, [r])
  }
  const out: Folder[] = [...byName].map(([name, rows]) => {
    rows.sort(byReturn)
    return { name, rows, hint: hint(rows) }
  })
  const newest = (f: Folder): number => f.rows[0]?.returnedMs ?? 0
  out.sort((a, b) => newest(b) - newest(a))
  return out
}

/** How many of a folder's chats show: all while searching or after `Show N more`. */
export const folderShown = (count: number, more: boolean, searching: boolean): number =>
  searching || more ? count : Math.min(FOLDER_SHOWN, count)

/** Project icons by workspace name (native PROJECT_ICONS); others get a lettered tile. */
export const PROJECT_ICON_NAMES = ['Eva', 'EvaOS', 'eCard', 'GoodOps', 'Relay'] as const

/**
 * The badge's two letters: the first two capitals ("OpenFlight" reads "OF"), else the first two
 * words' initials, else the first two letters or digits.
 */
export function projectInitials(name: string): string {
  const capitals = [...name].filter((c) => c >= 'A' && c <= 'Z').slice(0, 2)
  if (capitals.length === 2) return capitals.join('')
  const words = name.split(/\s+/).filter((w) => w !== '')
  const letters =
    words.length >= 2
      ? words
          .map((w) => [...w][0] ?? '')
          .slice(0, 2)
          .join('')
      : [...name]
          .filter((c) => /[\p{L}\p{N}]/u.test(c))
          .slice(0, 2)
          .join('')
  return letters.toUpperCase()
}

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const U64 = (1n << 64n) - 1n

/** Which of `colors` chart colors a workspace's badge takes: FNV-1a 64 of its UTF-8 name. */
export function projectColor(name: string, colors = 5): number {
  let hash = FNV_OFFSET
  for (const byte of new TextEncoder().encode(name)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & U64
  }
  return Number(hash % BigInt(Math.max(1, colors)))
}

/** The text before the PR: the branch, led by the key unless the branch names it. */
export function workLabel(w: ChatRow['work']): string | null {
  if (!w) return null
  if (w.key !== null && w.branch !== null) {
    return w.branch.includes(w.key) ? w.branch : `${w.key} · ${w.branch}`
  }
  return w.key ?? w.branch
}

/** A raw model id as people say it: "anthropic/claude-opus-4-1" reads "Claude Opus 4.1". */
export function modelName(raw: string): string {
  const slash = raw.lastIndexOf('/')
  const id = slash < 0 ? raw : raw.slice(slash + 1)
  const words: string[] = []
  let afterNumber = false
  for (const part of id.split(/[-_]/).filter((p) => p !== '')) {
    if (/^\d+$/.test(part) && part.length >= 6) continue
    const number = /^[\d.]+$/.test(part)
    const last = words.length - 1
    if (last >= 0 && number && afterNumber) words[last] += `.${part}`
    else if (last >= 0 && words[last] === 'GPT') words[last] += `-${part}`
    else if (part.toLowerCase() === 'gpt') words.push('GPT')
    else if (number || /\d/.test(part)) words.push(part)
    else words.push(part[0]!.toUpperCase() + part.slice(1))
    afterNumber = number
  }
  return words.length === 0 ? raw : words.join(' ')
}

/** The default digest times (native inbox DIGESTS); Electron has no digest settings. */
export const DIGESTS: readonly (readonly [number, number])[] = [
  [8, 30],
  [13, 0],
  [17, 30],
]

export type SnoozeLabel =
  | 'In 1 hour'
  | 'Next digest'
  | 'Evening digest'
  | 'Tomorrow morning digest'
  | 'Monday'

export interface SnoozeOption {
  label: SnoozeLabel
  /** "Today 17:30", "Thu Oct 15 08:30". */
  when: string
  untilMs: number
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * Snooze times from `now` (native inbox::snooze_options): an hour on, the next digest, the
 * evening digest, tomorrow's morning digest and Monday morning, each only when later than now
 * and different from an earlier one. Local time.
 */
export function snoozeOptions(now: Date): SnoozeOption[] {
  const first = DIGESTS[0]!
  const last = DIGESTS[DIGESTS.length - 1]!
  const at = (dayOffset: number, [h, m]: readonly [number, number]): Date =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, m, 0, 0)
  const next = DIGESTS.map((t) => at(0, t)).find((d) => d > now) ?? at(1, first)
  const weekday = now.getDay()
  const toMonday = weekday === 1 ? 7 : (8 - weekday) % 7
  const candidates: [SnoozeLabel, Date][] = [
    ['In 1 hour', new Date(now.getTime() + 3600_000)],
    ['Next digest', next],
    ['Evening digest', at(0, last)],
    ['Tomorrow morning digest', at(1, first)],
    ['Monday', at(toMonday, first)],
  ]
  const seen = new Set<number>()
  const out: SnoozeOption[] = []
  for (const [label, when] of candidates) {
    const ms = when.getTime()
    if (ms <= now.getTime() || seen.has(ms)) continue
    seen.add(ms)
    const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`
    const today = when.toDateString() === now.toDateString()
    out.push({
      label,
      when: today
        ? `Today ${time}`
        : `${DAYS[when.getDay()]} ${MONTHS[when.getMonth()]} ${when.getDate()} ${time}`,
      untilMs: ms,
    })
  }
  return out
}
