// Pure meeting rules ported from meetings.rs and meetings_view.rs. No fs (see meetings-read.ts).
import { addDays, localDate, parseDay } from './dates'

export const DEFAULT_WORKSPACE = 'eva'
const WEEK_MS = 7 * 86_400_000

export type ProposalStatus = 'proposed' | 'accepted' | 'dismissed'

export interface Proposal {
  id: string
  kind: string
  text: string
  workspace: string | null
  item: string | null
  p: number | null
  source: string | null
  status: ProposalStatus
}
export interface Memory {
  kind: string
  text: string
  where: string[]
  p: number | null
}
export interface Meeting {
  stem: string
  title: string
  start: string | null
  notes: string | null
  skipped: boolean
  skippedReason: string | null
  proposals: Proposal[]
  memorized: Memory[]
}
export interface Digest {
  recent: Meeting[]
  waiting: Array<{ meeting: Meeting; proposal: Proposal }>
  out: Array<{ text: string; date: string | null; meeting: Meeting }>
  decisions: Array<{ text: string; meeting: Meeting }>
}

export class MeetingError extends Error {
  readonly code: 'not-proposed' | 'not-found' | 'invalid-record'
  constructor(code: MeetingError['code'], message: string) {
    super(message)
    this.name = 'MeetingError'
    this.code = code
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Anything unrecognized reads as still proposed. */
function statusOf(v: unknown): ProposalStatus {
  return v === 'accepted' || v === 'dismissed' ? v : 'proposed'
}

/** false, null, absent and blank strings read as not skipped; everything else is skipped. */
export function isSkipped(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

function parseProposal(v: unknown): Proposal | null {
  if (!isObj(v)) return null
  return {
    id: str(v.id),
    kind: str(v.kind),
    text: str(v.text),
    workspace: strOrNull(v.workspace),
    item: strOrNull(v.item),
    p: numOrNull(v.p),
    source: strOrNull(v.source),
    status: statusOf(v.status),
  }
}

function parseMemory(v: unknown): Memory | null {
  if (!isObj(v)) return null
  return {
    kind: str(v.kind),
    text: str(v.text),
    where: Array.isArray(v.where) ? v.where.filter((w): w is string => typeof w === 'string') : [],
    p: numOrNull(v.p),
  }
}

/** One work/meetings/<stem>.json; null for invalid JSON. The stem always comes from the filename. */
export function parseMeeting(stem: string, jsonText: string): Meeting | null {
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (!isObj(raw)) return null
  const list = <T>(v: unknown, f: (x: unknown) => T | null): T[] =>
    Array.isArray(v) ? v.map(f).filter((x): x is T => x !== null) : []
  return {
    stem,
    title: str(raw.title),
    start: strOrNull(raw.start),
    notes: strOrNull(raw.notes),
    skipped: isSkipped(raw.skipped),
    skippedReason:
      typeof raw.skipped === 'string' && raw.skipped.trim() !== '' ? raw.skipped : null,
    proposals: list(raw.proposals, parseProposal),
    memorized: list(raw.memorized, parseMemory),
  }
}

function startMs(m: Meeting): number | null {
  if (m.start === null) return null
  const t = Date.parse(m.start)
  return Number.isNaN(t) ? null : t
}

/** Newest start first, undated last, ties by stem descending. */
export function sortMeetings(meetings: readonly Meeting[]): Meeting[] {
  return [...meetings].sort((a, b) => {
    const x = startMs(a)
    const y = startMs(b)
    if ((x === null) !== (y === null)) return x === null ? 1 : -1
    if (x !== null && y !== null && x !== y) return y - x
    return a.stem < b.stem ? 1 : a.stem > b.stem ? -1 : 0
  })
}

export function displayTitle(m: Meeting): string {
  return m.title.trim() === '' ? m.stem : m.title
}

export function pendingProposals(m: Meeting): number {
  return m.proposals.filter((p) => p.status === 'proposed').length
}

/** Local YYYY-MM-DD of the start, or null. Uses local getters, never string slicing. */
export function dayKey(start: string | null): string | null {
  if (start === null) return null
  const t = Date.parse(start)
  return Number.isNaN(t) ? null : localDate(new Date(t))
}

export type DayLabelStyle = 'sidebar' | 'rust'

const SIDEBAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const RUST = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' })

/** Today, Yesterday, else `Sep 14` (sidebar) or `Mon, Oct 5` (rust); null key is Undated. */
export function dayLabel(
  key: string | null,
  today: string,
  style: DayLabelStyle = 'sidebar',
): string {
  if (key === null) return 'Undated'
  if (key === today) return 'Today'
  if (key === addDays(today, -1)) return 'Yesterday'
  const d = parseDay(key)
  if (!d) return key
  return (style === 'rust' ? RUST : SIDEBAR).format(d)
}

export interface DayGroup {
  key: string | null
  label: string
  meetings: Meeting[]
}

/** Day groups in list order; skipped meetings go to `tests`. */
export function groupByDay(
  meetings: readonly Meeting[],
  today: string,
  style: DayLabelStyle = 'sidebar',
): { groups: DayGroup[]; tests: Meeting[] } {
  const groups: DayGroup[] = []
  const tests: Meeting[] = []
  for (const m of meetings) {
    if (m.skipped) {
      tests.push(m)
      continue
    }
    const key = dayKey(m.start)
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.meetings.push(m)
    else groups.push({ key, label: dayLabel(key, today, style), meetings: [m] })
  }
  return { groups, tests }
}

/** Case-insensitive substring over the display title; a query forces the test-call fold open. */
export function filterByTitle(
  meetings: readonly Meeting[],
  query: string,
): { meetings: Meeting[]; forceTestsOpen: boolean } {
  const q = query.trim().toLowerCase()
  return {
    meetings:
      q === '' ? [...meetings] : meetings.filter((m) => displayTitle(m).toLowerCase().includes(q)),
    forceTestsOpen: q !== '',
  }
}

const TRAILING_DATE = /\(\s*(\d{4}-\d{2}-\d{2})\s*\)\s*$/

/** The date a memory resolved to: its trailing (YYYY-MM-DD). */
export function memoryDate(text: string): string | null {
  const m = TRAILING_DATE.exec(text)
  return m && parseDay(m[1]!) ? m[1]! : null
}

/** A memory's text without the trailing date. */
export function memoryText(text: string): string {
  return memoryDate(text) === null ? text.trim() : text.replace(TRAILING_DATE, '').trimEnd()
}

/** What the Meetings home shows, from non-skipped records. */
export function digest(meetings: readonly Meeting[], now: Date): Digest {
  const today = localDate(now)
  const out: Digest = { recent: [], waiting: [], out: [], decisions: [] }
  for (const meeting of sortMeetings(meetings).filter((m) => !m.skipped)) {
    const t = startMs(meeting)
    const recent = t !== null && t > now.getTime() - WEEK_MS
    if (recent) out.recent.push(meeting)
    for (const proposal of meeting.proposals) {
      if (proposal.status === 'proposed') out.waiting.push({ meeting, proposal })
    }
    for (const mem of meeting.memorized) {
      if (mem.kind === 'availability') {
        const date = memoryDate(mem.text)
        if (date === null ? recent : date >= today) {
          out.out.push({ text: memoryText(mem.text), date, meeting })
        }
      } else if (mem.kind === 'decision' && recent) {
        out.decisions.push({ text: memoryText(mem.text), meeting })
      }
    }
  }
  return out
}

/** The home subtext, e.g. `3 meetings this week. 7 action items waiting on you.` */
export function digestLine(recent: number, waiting: number): string {
  const a =
    recent === 0
      ? 'No meetings this week.'
      : recent === 1
        ? '1 meeting this week.'
        : `${recent} meetings this week.`
  const b =
    waiting === 0
      ? 'Nothing waiting on you.'
      : waiting === 1
        ? '1 action item waiting on you.'
        : `${waiting} action items waiting on you.`
  return `${a} ${b}`
}

/** Todo tag and text for accepting a proposal; `localDay` is the meeting's local YYYY-MM-DD or ''. */
export function todoText(
  p: Proposal,
  meetingTitle: string,
  localDay: string,
): { tag: string; text: string } {
  const ws = p.workspace?.trim()
  const prefix = p.kind === 'ticket' ? 'Draft ticket: ' : ''
  const from = localDay === '' ? meetingTitle : `${meetingTitle}, ${localDay}`
  return {
    tag: ws ? ws : DEFAULT_WORKSPACE,
    text: `${prefix}${p.text.trim()} (from meeting ${from})`,
  }
}

/**
 * Sets proposals[i].status, keeping every other field and key order. 2-space JSON plus a
 * trailing newline. Throws code 'not-found' or 'not-proposed'.
 */
export function setProposalStatus(
  jsonText: string,
  proposalId: string,
  status: 'accepted' | 'dismissed',
): string {
  let record: unknown
  try {
    record = JSON.parse(jsonText)
  } catch {
    throw new MeetingError('invalid-record', 'The meeting record is not valid JSON.')
  }
  const proposals = isObj(record) && Array.isArray(record.proposals) ? record.proposals : []
  const proposal = proposals.find(
    (p): p is Record<string, unknown> => isObj(p) && p.id === proposalId,
  )
  if (!proposal) throw new MeetingError('not-found', `No proposal ${proposalId}.`)
  if (statusOf(proposal.status) !== 'proposed') {
    throw new MeetingError(
      'not-proposed',
      `Proposal ${proposalId} is already ${String(proposal.status)}.`,
    )
  }
  proposal.status = status
  return `${JSON.stringify(record, null, 2)}\n`
}
