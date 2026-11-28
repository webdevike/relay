import { AGENT_COLUMNS, type AgentBoard, type AgentCard, type AgentColumn } from '@evaos/contract'

export const COLUMN_TITLE: Record<AgentColumn, string> = {
  queued: 'Queued',
  working: 'Working',
  needs: 'Needs Isaac',
  review: 'In review',
  qa: 'Merged/QA',
  done: 'Done',
}

export type CardTicket = NonNullable<AgentCard['ticket']>
export type CardWaiting = NonNullable<CardTicket['waiting']>
export type TicketsSource = AgentBoard['sources']['tickets']

export interface BoardFilters {
  query: string
  /** Only cards someone is waiting on Isaac for (a waiting mention or a Needs you reason). */
  waitingOnly: boolean
}

export const DEFAULT_FILTERS: BoardFilters = { query: '', waitingOnly: false }

/** Columns hidden until Isaac shows them: Done, as Linear's board does. */
export const DEFAULT_HIDDEN: readonly AgentColumn[] = ['done']

/** A saved hidden-columns list: known columns only, each once, in board order. */
export function parseHidden(raw: unknown): AgentColumn[] | null {
  if (!Array.isArray(raw)) return null
  return AGENT_COLUMNS.filter((c) => raw.includes(c))
}

/** Someone is waiting on Isaac: an unanswered mention or a Needs you reason. */
export function needsIsaac(c: AgentCard): boolean {
  const t = c.ticket
  return t ? t.waiting !== null || t.needsYou !== null : false
}

/** The waiting mention a card shows, unless Isaac just marked it handled here. */
export function waitingOf(c: AgentCard, handled: ReadonlySet<string>): CardWaiting | null {
  const w = c.ticket?.waiting ?? null
  return w !== null && !handled.has(waitingId(w)) ? w : null
}

/** One waiting mention, as far as Mark as handled goes (a newer comment is a new id). */
export function waitingId(w: CardWaiting): string {
  return `${w.provider}:${w.itemId}:${w.commentId}`
}

function matches(c: AgentCard, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const text = [c.key, c.title, c.session, c.agent].filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => text.includes(w))
}

/** The cards on the board: never stale ones; then the words (key, title, session, agent) and the waiting toggle. */
export function visibleCards(cards: readonly AgentCard[], f: BoardFilters): AgentCard[] {
  const words = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return cards.filter((c) => !c.stale && (!f.waitingOnly || needsIsaac(c)) && matches(c, words))
}

/** How many live cards the Waiting on you toggle would keep. */
export function waitingCount(cards: readonly AgentCard[]): number {
  return cards.filter((c) => !c.stale && needsIsaac(c)).length
}

/** Cards per column, in column order; `columnOf` places a card mid-move where it is going. */
export function byColumn(
  cards: readonly AgentCard[],
  columnOf: (id: string) => AgentColumn | null = () => null,
): Record<AgentColumn, AgentCard[]> {
  const out = Object.fromEntries(AGENT_COLUMNS.map((c) => [c, [] as AgentCard[]])) as Record<
    AgentColumn,
    AgentCard[]
  >
  for (const c of cards) out[columnOf(c.id) ?? c.column].push(c)
  return out
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

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

/** A card's last line: `Created Nov 15` for a ticket, `Updated 5m ago` for a run. */
export function footLabel(c: AgentCard, now: number): string | null {
  if (c.ticket) return `Created ${MONTH.format(c.ticket.createdAt)}`
  if (c.activityAt === null) return null
  const ago = agoLabel(c.activityAt, now)
  return ago === 'now' ? 'Updated just now' : `Updated ${ago} ago`
}

/** The toolbar's freshness words: `Synced 2m ago`, or why there is no sync. */
export function freshnessLabel(t: TicketsSource, now: number): string {
  if (t.source === 'fallback') return t.message ?? 'Linear sync is off'
  if (t.lastSyncAt === null) return 'Syncing'
  const ago = agoLabel(t.lastSyncAt, now)
  return ago === 'now' ? 'Synced just now' : `Synced ${ago} ago`
}
