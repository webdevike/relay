// The chat turn navigator's model, shared by Relay desktop and the phone: a log's rows become turns
// (a tick each), each flagged when it wants Isaac, and ticks are compressed to the room they have.
// Pure: no React, no scroll state. A client adapts its own rows to `TurnRow`.
import { ISAAC_REACTOR, reactionKey, type ThreadReactions } from './reactions'
import { splitReplies } from './replies'
import { plain, replyFlags, untag, type TurnFlag } from './turn-flags'

/** A silence between two assistant texts longer than this makes the later one a turn of its own (it spoke first). */
export const PROACTIVE_GAP_MS = 30 * 60 * 1000
/** A user message this soon after an assistant-started turn counts as engaging with it. */
export const ENGAGE_MS = 20 * 60 * 1000

/**
 * One row of a client's log, as the navigator reads it. Rows other than Isaac's messages, the
 * assistant's replies and an open ask card are left out by the adapter.
 */
export interface TurnRow {
  /** Position in the client's log: where a jump to the turn goes. */
  index: number
  /** The row's id there (what a jump flashes). */
  id: string
  /** `ask`: an ask card Isaac has not answered yet (its text is unused). */
  role: 'user' | 'assistant' | 'ask'
  text: string
  /** omp's timestamp (epoch ms), absent on a row not yet echoed or streaming. */
  at?: number | undefined
  streaming?: boolean | undefined
  /** The message carries pictures (a title for a picture-only message). */
  images?: boolean | undefined
  /** The client's own row object: derived text and flags are cached by its identity. */
  ref: object
}

/** One tick of the navigator: a user message and what the assistant answered, or an assistant that spoke first. */
export interface Turn {
  /** Stable across sessions and devices: the starting bubble's reaction key, else its row id. Bookmarks use it. */
  key: string
  /** Id of the row the turn starts at. */
  row: string
  /** Position of that row in the log. */
  item: number
  led: 'user' | 'assistant'
  /** The user message (an assistant-led turn: the assistant's first line), one line. */
  title: string
  /** The start of the assistant's reply, one line. */
  reply: string
  /** Set while the turn wants Isaac and he has not answered or reacted. */
  flag: TurnFlag | null
}

interface Draft {
  key: string
  row: string
  item: number
  led: 'user' | 'assistant'
  user: TurnRow | null
  replies: TurnRow[]
  ask: boolean
}

const plainCache = new WeakMap<object, string>()
const flagCache = new WeakMap<object, { ask: boolean; shipped: boolean }>()

function plainOf(r: TurnRow): string {
  let v = plainCache.get(r.ref)
  if (v === undefined) {
    v = plain(r.text)
    plainCache.set(r.ref, v)
  }
  return v
}

function flagsOf(r: TurnRow): { ask: boolean; shipped: boolean } {
  let v = flagCache.get(r.ref)
  if (v === undefined) {
    v = replyFlags(r.text)
    flagCache.set(r.ref, v)
  }
  return v
}

/** A row's reaction key: its role and timestamp, else null. */
export function turnKeyOf(r: Pick<TurnRow, 'role' | 'at'>): string | null {
  return r.role === 'ask' || r.at === undefined ? null : reactionKey(r.role, r.at)
}

/** First line and the rest of an assistant text, each plain. */
function splitFirstLine(text: string): [string, string] {
  const body = untag(text).replace(/^\s+/, '')
  const nl = body.indexOf('\n')
  return nl < 0
    ? [plain(body, 200), '']
    : [plain(body.slice(0, nl), 200), plain(body.slice(nl), 280)]
}

function drafts(rows: Iterable<TurnRow>): Draft[] {
  const out: Draft[] = []
  let cur: Draft | null = null
  let lastText: number | undefined
  for (const r of rows) {
    if (r.role === 'user') {
      cur = {
        key: turnKeyOf(r) ?? r.id,
        row: r.id,
        item: r.index,
        led: 'user',
        user: r,
        replies: [],
        ask: false,
      }
      out.push(cur)
      lastText = undefined
    } else if (r.role === 'assistant') {
      const spoke =
        cur === null ||
        (lastText !== undefined && r.at !== undefined && r.at - lastText > PROACTIVE_GAP_MS)
      if (spoke) {
        cur = {
          key: turnKeyOf(r) ?? r.id,
          row: r.id,
          item: r.index,
          led: 'assistant',
          user: null,
          replies: [],
          ask: false,
        }
        out.push(cur)
      }
      cur!.replies.push(r)
      if (r.at !== undefined) lastText = r.at
    } else if (cur !== null) {
      cur.ask = true
    }
  }
  return out
}

/** Whether Isaac reacted to any assistant bubble of the turn. */
function reacted(d: Draft, reactions: ThreadReactions | undefined): boolean {
  if (reactions === undefined) return false
  return d.replies.some((r) => {
    const key = turnKeyOf(r)
    return key !== null && reactions[key]?.[ISAAC_REACTOR] !== undefined
  })
}

/** Whether `next`, the user message that followed an assistant-led turn, answers it: soon after, a tapped reply, or a quote. */
function engaged(d: Draft, next: TurnRow): boolean {
  const last = d.replies.at(-1)
  if (last?.at !== undefined && next.at !== undefined && next.at - last.at <= ENGAGE_MS) return true
  const said = next.text.trim().toLowerCase()
  const chips = splitReplies(last?.text ?? '', false).replies ?? []
  if (chips.some((c) => c.toLowerCase() === said)) return true
  const head = plainOf(d.replies[0]!).slice(0, 24).trim()
  return (
    said.startsWith('>') &&
    head !== '' &&
    plain(next.text.replace(/^>\s?/gm, ''), 400).includes(head)
  )
}

/**
 * The log's turns: a tick each. A turn starts at a user message, or at an assistant text that came
 * long after the last one (the assistant spoke first). A turn is flagged `ask` when its reply ends
 * with a question, offers tap-to-answer replies or left an ask card open; `shipped` when it says
 * something is live, shipped, ready or to restart, or links a deploy; and only while Isaac has
 * neither reacted to it nor answered. A user-led turn is answered by his next message; an
 * assistant-led one by a reaction, a message soon after, a tapped reply or a quote of it.
 */
export function buildTurns(
  rows: Iterable<TurnRow>,
  reactions: ThreadReactions | undefined,
): Turn[] {
  const ds = drafts(rows)
  const turns: Turn[] = new Array<Turn>(ds.length)
  // The user message that follows each turn, found from the end.
  let next: TurnRow | null = null
  for (let i = ds.length - 1; i >= 0; i--) {
    const d = ds[i]!
    const first = d.replies[0]
    let title: string
    let reply: string
    if (d.user !== null) {
      title = plain(d.user.text, 200) || (d.user.images === true ? 'Image' : '')
      reply = first === undefined ? '' : plainOf(first)
    } else {
      ;[title, reply] = splitFirstLine(first!.text)
      if (reply === '' && d.replies[1] !== undefined) reply = plainOf(d.replies[1])
    }
    let flag: TurnFlag | null = null
    const last = d.replies.at(-1)
    const streaming = d.replies.some((r) => r.streaming === true)
    if (!streaming && !reacted(d, reactions)) {
      const answered = next !== null && (d.led === 'user' || engaged(d, next))
      if (!answered) {
        if (d.ask || (last !== undefined && flagsOf(last).ask)) flag = 'ask'
        else if (d.replies.some((r) => flagsOf(r).shipped)) flag = 'shipped'
      }
    }
    turns[i] = { key: d.key, row: d.row, item: d.item, led: d.led, title, reply, flag }
    if (d.user !== null) next = d.user
  }
  return turns
}

/** The turn whose rows contain log position `item` (the last turn starting at or before it); 0 before the first. */
export function turnOfItem(turns: readonly Turn[], item: number): number {
  let lo = 0
  let hi = turns.length - 1
  let at = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (turns[mid]!.item <= item) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return at
}

/** Index in `turns` of the last turn that starts at or above `top`; 0 when none does. Offsets grow with the turns. */
export function turnAt(
  turns: readonly Turn[],
  offsetOf: (item: number) => number,
  top: number,
): number {
  let lo = 0
  let hi = turns.length - 1
  let at = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsetOf(turns[mid]!.item) <= top) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return at
}

/** Slack, in px, under which a turn that starts at the top edge counts as already there. */
const AT_TOP = 4

/**
 * The turn Alt+Down or Alt+Up goes to from scroll position `top`: the first one that starts below
 * it, or the last one that starts above it (the start of the turn Isaac is inside, when he is
 * partway down it). Null when there is none that way.
 */
export function stepTurn(
  turns: readonly Turn[],
  offsetOf: (item: number) => number,
  top: number,
  dir: 1 | -1,
): number | null {
  let lo = 0
  let hi = turns.length - 1
  // Count of turns starting at or above the edge (the one we are in and everything before it).
  const edge = dir === 1 ? top + AT_TOP : top - AT_TOP
  let above = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const off = offsetOf(turns[mid]!.item)
    if (dir === 1 ? off <= edge : off < edge) {
      above = mid + 1
      lo = mid + 1
    } else hi = mid - 1
  }
  const to = dir === 1 ? above : above - 1
  return to >= 0 && to < turns.length ? to : null
}

/** Turns whose start is inside [top, bottom): the range of ticks that are on screen. */
export function visibleTurns(
  turns: readonly Turn[],
  offsetOf: (item: number) => number,
  top: number,
  bottom: number,
  active: number,
): [number, number] {
  let from = -1
  let to = -1
  // Binary search for the first turn at or below `top`.
  let lo = 0
  let hi = turns.length - 1
  let start = turns.length
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsetOf(turns[mid]!.item) >= top) {
      start = mid
      hi = mid - 1
    } else lo = mid + 1
  }
  for (let i = start; i < turns.length && offsetOf(turns[i]!.item) < bottom; i++) {
    if (from < 0) from = i
    to = i
  }
  return from < 0 ? [active, active] : [Math.min(from, active), Math.max(to, active)]
}

/** One drawn tick: a turn, or a run of turns when they do not all fit. */
export interface Tick {
  /** Range of shown turns the tick stands for (inclusive). */
  first: number
  last: number
  /** The turn a click or hover on it means. */
  rep: number
  /** The strongest flag in the run. */
  flag: TurnFlag | null
  bookmarked: boolean
  state: 'active' | 'visible' | 'idle'
}

/**
 * The ticks of `shown` turns in at most `slots` slots, like a scrollbar map: each slot stands for a
 * run of turns, marked when any in the run is flagged or bookmarked and standing for the active
 * turn, else the first flagged or bookmarked one, else the first. `range` is the visible turns.
 */
export function compressTicks(
  shown: readonly Turn[],
  bookmarks: ReadonlySet<string>,
  slots: number,
  active: number,
  range: readonly [number, number],
): Tick[] {
  const n = shown.length
  if (n === 0 || slots < 1) return []
  const count = Math.min(n, slots)
  const out: Tick[] = []
  for (let b = 0; b < count; b++) {
    const first = Math.floor((b * n) / count)
    const last = Math.floor(((b + 1) * n) / count) - 1
    let rep = first
    let marked = false
    let flag: TurnFlag | null = null
    let bookmarked = false
    for (let i = first; i <= last; i++) {
      const t = shown[i]!
      const mark = t.flag !== null || bookmarks.has(t.key)
      if (mark && !marked) {
        rep = i
        marked = true
      }
      if (t.flag === 'ask' || (t.flag === 'shipped' && flag === null)) flag = t.flag
      if (bookmarks.has(t.key)) bookmarked = true
    }
    const hasActive = active >= first && active <= last
    if (hasActive) rep = active
    out.push({
      first,
      last,
      rep,
      flag,
      bookmarked,
      state: hasActive ? 'active' : last >= range[0] && first <= range[1] ? 'visible' : 'idle',
    })
  }
  return out
}

/**
 * Each bubble's reaction key mapped to the key of the turn it belongs to: a reply of a turn names
 * that turn, so a bookmark made from any bubble marks its whole turn. Rows with no key (an open ask
 * card, a message not yet stamped) are left out.
 */
export function turnKeysByBubble(
  rows: readonly TurnRow[],
  turns: readonly Turn[],
): Map<string, string> {
  const out = new Map<string, string>()
  if (turns.length === 0) return out
  for (const r of rows) {
    const key = turnKeyOf(r)
    if (key !== null) out.set(key, turns[turnOfItem(turns, r.index)]!.key)
  }
  return out
}

/** The tick (index into the ticks) under a touch `y` px down a rail `height` px tall holding `count` ticks. */
export function tickAtY(y: number, height: number, count: number): number {
  if (count === 0 || height <= 0) return -1
  return Math.min(count - 1, Math.max(0, Math.floor((y / height) * count)))
}

/** Only the turns that want Isaac or are bookmarked. */
export function marked(turns: readonly Turn[], bookmarks: ReadonlySet<string>): Turn[] {
  return turns.filter((t) => t.flag !== null || bookmarks.has(t.key))
}

export type { TurnFlag }
