import type { ChatMessage } from '@evaos/chat-core/message'
import { ISAAC_REACTOR, reactionKeyOf, type ThreadReactions } from '@evaos/chat-core/reactions'
import { splitReplies } from '@evaos/chat-core/replies'
import type { LogItem } from '../ChatLog'
import { plain, replyFlags, untag, type TurnFlag } from './flags'

/** A silence between two assistant texts longer than this makes the later one a turn of its own (it spoke first). */
export const PROACTIVE_GAP_MS = 30 * 60 * 1000
/** A user message this soon after an assistant-started turn counts as engaging with it. */
export const ENGAGE_MS = 20 * 60 * 1000

/** One tick of the navigator: a user message and what the assistant answered, or an assistant that spoke first. */
export interface Turn {
  /** Stable across sessions: the starting bubble's reaction key, else its row id. Bookmarks use it. */
  key: string
  /** Row id of the message the turn starts at (what a jump flashes). */
  row: string
  /** Index of the turn's first item in the log. */
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
  user: ChatMessage | null
  replies: ChatMessage[]
  ask: boolean
}

const plainCache = new WeakMap<ChatMessage, string>()
const flagCache = new WeakMap<ChatMessage, { ask: boolean; shipped: boolean }>()

function plainOf(m: ChatMessage): string {
  let v = plainCache.get(m)
  if (v === undefined) {
    v = plain(m.text)
    plainCache.set(m, v)
  }
  return v
}

function flagsOf(m: ChatMessage): { ask: boolean; shipped: boolean } {
  let v = flagCache.get(m)
  if (v === undefined) {
    v = replyFlags(m.text)
    flagCache.set(m, v)
  }
  return v
}

/** The log's messages in order, tool groups opened. */
function* messagesOf(items: readonly LogItem[]): Generator<[number, ChatMessage]> {
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    if (it.kind === 'message') yield [i, it.m]
    else if (it.kind === 'tools') for (const t of it.tools) yield [i, t]
  }
}

/** First line and the rest of an assistant text, each plain. */
function splitFirstLine(text: string): [string, string] {
  const body = untag(text).replace(/^\s+/, '')
  const nl = body.indexOf('\n')
  return nl < 0
    ? [plain(body, 200), '']
    : [plain(body.slice(0, nl), 200), plain(body.slice(nl), 280)]
}

function drafts(items: readonly LogItem[]): Draft[] {
  const out: Draft[] = []
  let cur: Draft | null = null
  let lastText: number | undefined
  for (const [item, m] of messagesOf(items)) {
    if (m.role === 'user') {
      cur = {
        key: reactionKeyOf(m) ?? m.id,
        row: m.id,
        item,
        led: 'user',
        user: m,
        replies: [],
        ask: false,
      }
      out.push(cur)
      lastText = undefined
    } else if (m.role === 'assistant') {
      const spoke =
        cur === null ||
        (lastText !== undefined && m.at !== undefined && m.at - lastText > PROACTIVE_GAP_MS)
      if (spoke) {
        cur = {
          key: reactionKeyOf(m) ?? m.id,
          row: m.id,
          item,
          led: 'assistant',
          user: null,
          replies: [],
          ask: false,
        }
        out.push(cur)
      }
      cur!.replies.push(m)
      if (m.at !== undefined) lastText = m.at
    } else if (m.role === 'tool' && cur !== null) {
      // An ask card nobody answered yet: the tool has no result.
      if (m.text === 'ask' && m.tool?.result === null) cur.ask = true
    }
  }
  return out
}

/** Whether Isaac reacted to any assistant bubble of the turn. */
function reacted(d: Draft, reactions: ThreadReactions | undefined): boolean {
  if (reactions === undefined) return false
  return d.replies.some((m) => {
    const key = reactionKeyOf(m)
    return key !== null && reactions[key]?.[ISAAC_REACTOR] !== undefined
  })
}

/** Whether `next`, the user message that followed an assistant-led turn, answers it: soon after, a tapped reply, or a quote. */
function engaged(d: Draft, next: ChatMessage): boolean {
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
  items: readonly LogItem[],
  reactions: ThreadReactions | undefined,
): Turn[] {
  const ds = drafts(items)
  const turns: Turn[] = new Array<Turn>(ds.length)
  // The user message that follows each turn, found from the end.
  let next: ChatMessage | null = null
  for (let i = ds.length - 1; i >= 0; i--) {
    const d = ds[i]!
    const first = d.replies[0]
    let title: string
    let reply: string
    if (d.user !== null) {
      title = plain(d.user.text, 200) || (d.user.images.length > 0 ? 'Image' : '')
      reply = first === undefined ? '' : plainOf(first)
    } else {
      ;[title, reply] = splitFirstLine(first!.text)
      if (reply === '' && d.replies[1] !== undefined) reply = plainOf(d.replies[1])
    }
    let flag: TurnFlag | null = null
    const last = d.replies.at(-1)
    const streaming = d.replies.some((m) => m.streaming)
    if (!streaming && !reacted(d, reactions)) {
      const answered = next !== null && (d.led === 'user' || engaged(d, next))
      if (!answered) {
        if (d.ask || (last !== undefined && flagsOf(last).ask)) flag = 'ask'
        else if (d.replies.some((m) => flagsOf(m).shipped)) flag = 'shipped'
      }
    }
    turns[i] = { key: d.key, row: d.row, item: d.item, led: d.led, title, reply, flag }
    if (d.user !== null) next = d.user
  }
  return turns
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
