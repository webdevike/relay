// Decision cards in chat rooms (Assistants > Rooms): a poll, a pros/cons list, a question for Isaac
// and a decision record. Members make them with plain markers in a reply (`[[poll: q | a | b]]`,
// `[[vote: a]]`, `[[pros: subject | point]]`, `[[ask-isaac: q | Yes | No]]`, `[[decision: call |
// why | next]]` ...): `splitDecisionMarkers` cuts them out of the shown text, `applyDecisionMarkers`
// turns them into cards (new ones for the reply's message, updates to earlier ones: votes, points,
// disputes, agree / dissent). Isaac acts on the cards through `voteOn`, `callPoll`, `reopenPoll`,
// `answerQuestion` and `decide`. Everything here is pure; the engine (desktop main
// rooms/chat-room.ts) owns the room and persists it.
import { z } from 'zod'
import type { ROOM_ISAAC as IsaacId, Room, RoomCard } from './rooms'

/** rooms.ts's ROOM_ISAAC (a type import keeps this module free of a load cycle with rooms.ts). */
const ROOM_ISAAC: typeof IsaacId = 'isaac'

export const DecisionOptionSchema = z.object({ id: z.string(), label: z.string() })
export type DecisionOption = z.infer<typeof DecisionOptionSchema>

/** A vote: options as rows, each voter's pick (Isaac too), called by a member's decision or by Isaac. */
export const PollCardSchema = z.object({
  type: z.literal('poll'),
  /** The id of the message that carries it. */
  id: z.string(),
  /** The member who opened it. */
  by: z.string(),
  question: z.string(),
  options: z.array(DecisionOptionSchema),
  /** Each voter's option id, by author id (`isaac` included). */
  votes: z.record(z.string(), z.string()),
  state: z.enum(['open', 'called', 'reopened']),
  called: z.object({ option: z.string(), by: z.string() }).optional(),
})
export type PollCard = z.infer<typeof PollCardSchema>

/** One pro or con: who raised or backed it, and who disputes it. */
export const DecisionPointSchema = z.object({
  text: z.string(),
  by: z.array(z.string()),
  state: z.enum(['agreed', 'disputed']),
  against: z.array(z.string()).optional(),
})
export type DecisionPoint = z.infer<typeof DecisionPointSchema>

/** The tradeoffs of one subject, in two columns; later members add points and dispute them. */
export const ProsConsCardSchema = z.object({
  type: z.literal('proscons'),
  id: z.string(),
  subject: z.string(),
  pros: z.array(DecisionPointSchema),
  cons: z.array(DecisionPointSchema),
})
export type ProsConsCard = z.infer<typeof ProsConsCardSchema>

/** Something only Isaac can answer, with one-tap answers. Asking ends the members' burst. */
export const QuestionCardSchema = z.object({
  type: z.literal('question'),
  id: z.string(),
  /** The member who asks. */
  by: z.string(),
  text: z.string(),
  /** Why it matters ("Yes flips this to Postgres now"). */
  sub: z.string().optional(),
  answers: z.array(z.string()),
  answered: z.string().optional(),
})
export type QuestionCard = z.infer<typeof QuestionCardSchema>

/**
 * The room's call: the judge or chair proposes it, Isaac accepts it, overrides it with one of the
 * alternatives (the linked poll's other options) or reopens it.
 */
export const DecisionCardSchema = z.object({
  type: z.literal('decision'),
  id: z.string(),
  /** The member who made the call. */
  by: z.string(),
  /** The call itself. */
  title: z.string(),
  why: z.string(),
  agree: z.array(z.string()),
  dissent: z.array(z.object({ by: z.string(), note: z.string().optional() })),
  /** What happens next and who does it (a member id). */
  next: z.object({ who: z.string().optional(), text: z.string() }).optional(),
  alternatives: z.array(DecisionOptionSchema),
  /** The poll the call settles, and which of its options the call is. */
  poll: z.string().optional(),
  option: z.string().optional(),
  state: z.enum(['proposed', 'accepted', 'overridden', 'reopened']),
  /** The room's call before Isaac overrode it. */
  previous: z.string().optional(),
})
export type DecisionCard = z.infer<typeof DecisionCardSchema>

export const DECISION_CARD_TYPES = ['poll', 'proscons', 'question', 'decision'] as const
export type DecisionCardType = (typeof DECISION_CARD_TYPES)[number]
export type DecisionKindCard = PollCard | ProsConsCard | QuestionCard | DecisionCard

export const isDecisionCard = (card: RoomCard | undefined): card is DecisionKindCard =>
  card !== undefined && (DECISION_CARD_TYPES as readonly string[]).includes(card.type)

// ---- markers ------------------------------------------------------------------------------------

export const MAX_POLL_OPTIONS = 6
export const MAX_ANSWERS = 4
export const MAX_POINTS = 8
const MAX_LINE = 160
const MAX_OPTION = 80
const MAX_ANSWER = 40
const MAX_WHY = 400

/** What one marker in a reply asks for. */
export type DecisionMarker =
  | { kind: 'poll'; question: string; options: string[] }
  | { kind: 'vote'; option: string }
  | { kind: 'pros' | 'cons'; subject: string; points: string[] }
  | { kind: 'dispute'; point: string }
  | { kind: 'ask'; text: string; sub?: string; answers: string[] }
  | { kind: 'decision'; title: string; why: string; next?: string }
  | { kind: 'agree' }
  | { kind: 'dissent'; note: string }

const KINDS = [
  'poll',
  'vote',
  'pros',
  'cons',
  'dispute',
  'ask-isaac',
  'decision',
  'agree',
  'dissent',
]
const TOKEN = new RegExp(`\\[\\[\\s*(${KINDS.join('|')})\\s*(?::([^\\[\\]\\n]*))?\\]\\]`, 'gi')
const OPENERS = KINDS.map((k) => `[[${k}`)
const FENCE = /^[ \t]*(?:```|~~~)/

const clean = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** Distinct (case-insensitive), non-empty, bounded. */
function list(parts: readonly string[], max: number, each: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of parts) {
    const t = clean(p, each)
    const key = norm(t)
    if (t === '' || seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length === max) break
  }
  return out
}

/** One token's body as a marker; null when it lacks what it needs (it is still cut). */
export function parseMarker(kind: string, body: string): DecisionMarker | null {
  const parts = body.split('|')
  const first = clean(parts[0] ?? '', MAX_LINE)
  switch (kind.toLowerCase()) {
    case 'poll': {
      const options = list(parts.slice(1), MAX_POLL_OPTIONS, MAX_OPTION)
      return first !== '' && options.length >= 2 ? { kind: 'poll', question: first, options } : null
    }
    case 'vote':
      return first !== '' ? { kind: 'vote', option: first } : null
    case 'pros':
    case 'cons': {
      const points = list(parts.slice(1), MAX_POINTS, MAX_LINE)
      return first !== '' && points.length > 0
        ? { kind: kind.toLowerCase() as 'pros' | 'cons', subject: first, points }
        : null
    }
    case 'dispute':
      return first !== '' ? { kind: 'dispute', point: first } : null
    case 'ask-isaac': {
      const rest = parts.slice(1)
      const note = rest.find((p) => /^\s*note\s*:/i.test(p))
      const answers = list(
        rest.filter((p) => p !== note),
        MAX_ANSWERS,
        MAX_ANSWER,
      )
      if (first === '' || answers.length < 2) return null
      const sub = note ? clean(note.replace(/^\s*note\s*:/i, ''), MAX_LINE) : ''
      return { kind: 'ask', text: first, ...(sub ? { sub } : {}), answers }
    }
    case 'decision': {
      if (first === '') return null
      const why = clean(parts[1] ?? '', MAX_WHY)
      const next = clean(parts.slice(2).join('|'), MAX_LINE)
      return { kind: 'decision', title: first, why, ...(next ? { next } : {}) }
    }
    case 'agree':
      return { kind: 'agree' }
    case 'dissent':
      return { kind: 'dissent', note: first }
    default:
      return null
  }
}

/** Whether the text after the last `[[` is a marker that has only partly arrived. */
function partialMarker(tail: string): boolean {
  if (tail.includes(']]') || tail.includes('\n')) return false
  const t = tail.toLowerCase().replace(/\s+/g, '')
  return OPENERS.some((o) => o.startsWith(t) || t.startsWith(o))
}

/**
 * A reply's decision markers and the reply without them. Markers may sit anywhere on a line
 * outside code fences; a known marker is always cut, also when it is malformed (then it makes
 * nothing). While the reply is `streaming`, a marker that has only partly arrived at the end is
 * cut too, so `[[po` never flickers in. Lines left empty go, blank runs collapse.
 */
export function splitDecisionMarkers(
  text: string,
  streaming = false,
): { text: string; markers: DecisionMarker[] } {
  if (!text.includes('[')) return { text, markers: [] }
  const markers: DecisionMarker[] = []
  const lines = text.split('\n')
  const kept: string[] = []
  let fenced = false
  let cut = false
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      fenced = !fenced
      kept.push(line)
      return
    }
    if (fenced) {
      kept.push(line)
      return
    }
    let out = line.replace(TOKEN, (_all, kind: string, body: string | undefined) => {
      cut = true
      const m = parseMarker(kind, body ?? '')
      if (m) markers.push(m)
      return ''
    })
    if (streaming && i === lines.length - 1) {
      const at = out.lastIndexOf('[')
      const open = out.lastIndexOf('[[')
      const from = open >= 0 && open === at - 1 ? open : at
      if (from >= 0 && partialMarker(out.slice(from))) {
        out = out.slice(0, from)
        cut = true
      }
    }
    if (out !== line && out.trim() === '') return
    kept.push(out === line ? line : out.replace(/[ \t]{2,}/g, ' ').trimEnd())
  })
  if (!cut) return { text, markers }
  return {
    text: kept
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    markers,
  }
}

// ---- reading the cards ----------------------------------------------------------------------------

/** Lower case, spaces collapsed, edge punctuation off: how labels and points are compared. */
export const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'“”.,:;!?]+|[\s"'“”.,:;!?]+$/g, '')

/** Voters per option id, in the order they voted. */
export function pollTally(poll: PollCard): Record<string, string[]> {
  const t: Record<string, string[]> = Object.fromEntries(poll.options.map((o) => [o.id, []]))
  for (const [who, option] of Object.entries(poll.votes)) t[option]?.push(who)
  return t
}

/** The option with the most votes; null with no votes or a tie at the top. */
export function pollLeader(poll: PollCard): string | null {
  const t = pollTally(poll)
  let best: string | null = null
  let n = 0
  let tie = false
  for (const o of poll.options) {
    const c = t[o.id]!.length
    if (c > n) {
      best = o.id
      n = c
      tie = false
    } else if (c > 0 && c === n) tie = true
  }
  return tie ? null : best
}

export const optionLabel = (options: readonly DecisionOption[], id: string | undefined): string =>
  options.find((o) => o.id === id)?.label ?? ''

/**
 * The option `text` names: its number ("2"), its letter ("b"), its label, or the one label it is
 * part of (or that is part of it); null when nothing or more than one matches.
 */
export function matchOption(options: readonly DecisionOption[], text: string): string | null {
  const t = norm(text).replace(/^(option|#)\s*/, '')
  if (t === '') return null
  if (/^\d+$/.test(t)) return options[Number(t) - 1]?.id ?? null
  if (/^[a-z]$/.test(t) && options.length <= 26 && !options.some((o) => norm(o.label) === t))
    return options[t.charCodeAt(0) - 97]?.id ?? null
  const exact = options.find((o) => norm(o.label) === t)
  if (exact) return exact.id
  const loose = options.filter((o) => {
    const l = norm(o.label)
    return l.includes(t) || t.includes(l)
  })
  return loose.length === 1 ? loose[0]!.id : null
}

/** The newest card of `type` in the room (and among `fresh` cards not in it yet). */
export function latestCard<T extends DecisionCardType>(
  room: Pick<Room, 'messages'>,
  type: T,
  fresh: readonly DecisionKindCard[] = [],
): Extract<DecisionKindCard, { type: T }> | null {
  for (let i = fresh.length - 1; i >= 0; i--)
    if (fresh[i]!.type === type) return fresh[i] as Extract<DecisionKindCard, { type: T }>
  for (let i = room.messages.length - 1; i >= 0; i--) {
    const c = room.messages[i]!.card
    if (c?.type === type) return c as Extract<DecisionKindCard, { type: T }>
  }
  return null
}

/** The decision card with `id` (its message id) of `type`, or null. */
export function cardById<T extends DecisionCardType>(
  room: Pick<Room, 'messages'>,
  id: string,
  type: T,
): Extract<DecisionKindCard, { type: T }> | null {
  const c = room.messages.find((m) => m.id === id)?.card
  return c?.type === type ? (c as Extract<DecisionKindCard, { type: T }>) : null
}

// ---- members' markers -------------------------------------------------------------------------------

const decisionError = (message: string): Error =>
  Object.assign(new Error(message), { code: 'bad-input' })

/** Who agrees with a call on `option` and who dissents, from the poll's votes. */
function sides(
  poll: PollCard,
  option: string,
  first: readonly string[],
): Pick<DecisionCard, 'agree' | 'dissent'> {
  const agree = [...first]
  const dissent: DecisionCard['dissent'] = []
  for (const [who, pick] of Object.entries(poll.votes)) {
    if (pick === option) {
      if (!agree.includes(who)) agree.push(who)
    } else if (!agree.includes(who)) {
      dissent.push({ by: who, note: `Voted ${optionLabel(poll.options, pick)}` })
    }
  }
  return { agree, dissent }
}

/** The member `next` names first ("Polaris: add backups"), by first name or id. */
function nextOf(room: Pick<Room, 'agents'>, next: string): NonNullable<DecisionCard['next']> {
  const m = /^([A-Za-z][\w-]*)\s*:\s*(.+)$/.exec(next)
  if (m) {
    const name = m[1]!.toLowerCase()
    const who = room.agents.find(
      (a) => a.id.toLowerCase() === name || a.name.toLowerCase().split(/\s+/)[0] === name,
    )
    if (who) return { who: who.id, text: m[2]!.trim() }
  }
  return { text: next }
}

/**
 * Applies `author`'s markers: answers the new cards (in order) for the reply's message and its
 * follow-ups, after updating the cards they act on (votes on the newest open poll, points and
 * disputes on the pros/cons of the same subject, agree / dissent on the newest proposed decision).
 * New cards carry an empty `id`: the engine sets it to the message that holds the card.
 */
export function applyDecisionMarkers(
  room: Pick<Room, 'messages' | 'agents'>,
  author: string,
  markers: readonly DecisionMarker[],
): DecisionKindCard[] {
  const fresh: DecisionKindCard[] = []
  for (const m of markers) {
    switch (m.kind) {
      case 'poll':
        if (fresh.some((c) => c.type === 'poll')) break
        fresh.push({
          type: 'poll',
          id: '',
          by: author,
          question: m.question,
          options: m.options.map((label, i) => ({ id: `o${i + 1}`, label })),
          votes: {},
          state: 'open',
        })
        break
      case 'vote': {
        const p = latestCard(room, 'poll', fresh)
        const option = p && p.state !== 'called' ? matchOption(p.options, m.option) : null
        if (p && option) p.votes[author] = option
        break
      }
      case 'pros':
      case 'cons': {
        const key = norm(m.subject)
        let card =
          (fresh.find((c) => c.type === 'proscons' && norm(c.subject) === key) as
            ProsConsCard | undefined) ??
          (room.messages.findLast(
            (x) => x.card?.type === 'proscons' && norm(x.card.subject) === key,
          )?.card as ProsConsCard | undefined)
        if (!card) {
          card = { type: 'proscons', id: '', subject: m.subject, pros: [], cons: [] }
          fresh.push(card)
        }
        const side = card[m.kind]
        for (const text of m.points) {
          const have = side.find((p) => norm(p.text) === norm(text))
          if (have) {
            if (!have.by.includes(author)) have.by.push(author)
          } else if (side.length < MAX_POINTS * 2)
            side.push({ text, by: [author], state: 'agreed' })
        }
        break
      }
      case 'dispute': {
        const card = latestCard(room, 'proscons', fresh)
        if (!card) break
        const t = norm(m.point)
        const all = [...card.pros, ...card.cons]
        const hit =
          all.find((p) => norm(p.text) === t) ??
          (() => {
            const loose = all.filter((p) => norm(p.text).includes(t) || t.includes(norm(p.text)))
            return loose.length === 1 ? loose[0] : undefined
          })()
        if (!hit || (hit.by.length === 1 && hit.by[0] === author)) break
        hit.by = hit.by.filter((b) => b !== author)
        hit.against = [...new Set([...(hit.against ?? []), author])]
        hit.state = 'disputed'
        break
      }
      case 'ask':
        if (fresh.some((c) => c.type === 'question')) break
        fresh.push({
          type: 'question',
          id: '',
          by: author,
          text: m.text,
          ...(m.sub ? { sub: m.sub } : {}),
          answers: m.answers,
        })
        break
      case 'decision': {
        if (fresh.some((c) => c.type === 'decision')) break
        const poll = latestCard(room, 'poll', fresh)
        const option = poll ? matchOption(poll.options, m.title) : null
        const who =
          poll && option ? sides(poll, option, [author]) : { agree: [author], dissent: [] }
        const card: DecisionCard = {
          type: 'decision',
          id: '',
          by: author,
          title: m.title,
          why: m.why,
          ...who,
          ...(m.next ? { next: nextOf(room, m.next) } : {}),
          alternatives: poll ? poll.options.filter((o) => o.id !== option) : [],
          ...(poll ? { poll: poll.id } : {}),
          ...(option ? { option } : {}),
          state: 'proposed',
        }
        if (poll && option && poll.state !== 'called') {
          poll.state = 'called'
          poll.called = { option, by: author }
        }
        fresh.push(card)
        break
      }
      case 'agree':
      case 'dissent': {
        const d = latestCard(room, 'decision', fresh)
        if (!d || d.state !== 'proposed' || d.by === author) break
        d.agree = d.agree.filter((a) => a !== author)
        d.dissent = d.dissent.filter((x) => x.by !== author)
        if (m.kind === 'agree') d.agree.push(author)
        else d.dissent.push({ by: author, ...(m.note ? { note: m.note } : {}) })
        break
      }
    }
  }
  return fresh
}

// ---- Isaac's actions ----------------------------------------------------------------------------------

/** Isaac picks `option` (null, or his current pick again, takes his vote back). */
export function voteOn(poll: PollCard, option: string | null): void {
  if (poll.state === 'called') throw decisionError('The vote was called. Reopen it to vote.')
  if (option !== null && !poll.options.some((o) => o.id === option))
    throw decisionError('No such option.')
  if (option === null || poll.votes[ROOM_ISAAC] === option) delete poll.votes[ROOM_ISAAC]
  else poll.votes[ROOM_ISAAC] = option
}

/** Isaac calls the vote: `option`, else his own vote, else the leader. Answers the option. */
export function callPoll(poll: PollCard, option?: string): string {
  if (poll.state === 'called') throw decisionError('The vote is already called.')
  const pick = option ?? poll.votes[ROOM_ISAAC] ?? pollLeader(poll)
  if (!pick || !poll.options.some((o) => o.id === pick))
    throw decisionError('Pick an option to call it.')
  poll.state = 'called'
  poll.called = { option: pick, by: ROOM_ISAAC }
  return pick
}

export function reopenPoll(poll: PollCard): void {
  if (poll.state !== 'called') throw decisionError('The vote is open.')
  poll.state = 'reopened'
  delete poll.called
}

/** Isaac's answer; it must be one of the card's answers. */
export function answerQuestion(card: QuestionCard, answer: string): string {
  if (card.answered !== undefined) throw decisionError('That question is answered.')
  const pick = card.answers.find((a) => norm(a) === norm(answer))
  if (!pick) throw decisionError('Not one of the answers.')
  card.answered = pick
  return pick
}

export type DecideAction = 'accept' | 'override' | 'reopen'

/**
 * Isaac's call on a decision. accept: a proposed call stands (its poll is called on it).
 * override: one of the alternatives becomes the call; who agrees and who dissents is read again
 * from the poll's votes. reopen: the decision and its poll are open again.
 */
export function decide(
  card: DecisionCard,
  action: DecideAction,
  option: string | undefined,
  poll: PollCard | null,
): void {
  if (action === 'reopen') {
    if (card.state === 'reopened') throw decisionError('The decision is already reopened.')
    card.state = 'reopened'
    if (poll && poll.state === 'called') reopenPoll(poll)
    return
  }
  if (card.state !== 'proposed') throw decisionError('Only a proposed decision takes that.')
  if (action === 'accept') {
    card.state = 'accepted'
    if (!card.agree.includes(ROOM_ISAAC)) card.agree.push(ROOM_ISAAC)
    card.dissent = card.dissent.filter((d) => d.by !== ROOM_ISAAC)
    if (poll && card.option && poll.state !== 'called') {
      poll.state = 'called'
      poll.called = { option: card.option, by: ROOM_ISAAC }
    }
    return
  }
  const alt = card.alternatives.find((a) => a.id === option)
  if (!alt) throw decisionError('Pick one of the alternatives.')
  const previous = card.title
  const was = card.option
  const members = [...card.agree, ...card.dissent.map((d) => d.by)].filter((m) => m !== ROOM_ISAAC)
  card.previous = previous
  card.title = alt.label
  card.option = alt.id
  card.alternatives = [
    ...(was ? [{ id: was, label: previous }] : []),
    ...card.alternatives.filter((a) => a.id !== alt.id),
  ]
  card.why = `You overrode the room's call (${previous}).`
  if (poll) {
    const s = sides(poll, alt.id, [ROOM_ISAAC])
    card.agree = s.agree
    card.dissent = [
      ...s.dissent.filter((d) => d.by !== ROOM_ISAAC),
      ...members
        .filter((m) => !s.agree.includes(m) && !s.dissent.some((d) => d.by === m))
        .map((by) => ({ by, note: `Recommended ${previous}` })),
    ]
    poll.state = 'called'
    poll.called = { option: alt.id, by: ROOM_ISAAC }
  } else {
    card.agree = [ROOM_ISAAC]
    card.dissent = members.map((by) => ({ by, note: `Recommended ${previous}` }))
  }
  card.state = 'overridden'
}
