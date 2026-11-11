// What a chat room's decision cards add up to, for the surfaces that keep Isaac in the know: the
// "Where we are" strip under the notch, the catch-up pill (and its summary) while he reads back,
// and the "Since you left" block where he stopped. All derived from the room as it is: no model
// calls, nothing stored but the last message he saw (RoomFeed keeps that in the UI prefs).
import {
  ROOM_SYSTEM,
  latestCard,
  optionLabel,
  pollLeader,
  pollTally,
  type Room,
  type RoomMessage,
} from '@evaos/contract'
import { ISAAC } from './types'

export interface WhereWeAre {
  /** The question on the table: the newest poll's, else what Isaac first asked. */
  question: string
  /** Decided X, Leaning X (with "n of m"), a split vote, voting, or still opening positions. */
  lean:
    | { kind: 'decided' | 'leaning'; text: string; count?: string }
    | { kind: 'split' | 'voting' | 'open' }
  /** What waits on Isaac, and the message it is on. */
  you:
    | { kind: 'question'; count: number; target: string }
    | { kind: 'decision'; target: string }
    | null
}

/**
 * The strip's content; null while the room has no decision card and nothing waits on Isaac. A
 * member's outward action waiting for his Allow (a guard ask) counts as a question for him.
 */
export function whereWeAre(room: Pick<Room, 'messages' | 'prompt' | 'title'>): WhereWeAre | null {
  const poll = latestCard(room, 'poll')
  const decision = latestCard(room, 'decision')
  const open = room.messages.filter(
    (m) =>
      (m.card?.type === 'question' && m.card.answered === undefined) ||
      (m.card?.type === 'ask' && m.card.answered === undefined),
  )
  if (
    !poll &&
    !decision &&
    !latestCard(room, 'proscons') &&
    !latestCard(room, 'question') &&
    open.length === 0
  )
    return null
  let lean: WhereWeAre['lean'] = { kind: 'open' }
  if (decision && decision.state !== 'reopened') lean = { kind: 'decided', text: decision.title }
  else if (poll?.state === 'called' && poll.called)
    lean = { kind: 'decided', text: optionLabel(poll.options, poll.called.option) }
  else if (poll) {
    const leader = pollLeader(poll)
    const voted = Object.keys(poll.votes).length
    lean = leader
      ? {
          kind: 'leaning',
          text: optionLabel(poll.options, leader),
          count: `${pollTally(poll)[leader]!.length} of ${voted}`,
        }
      : { kind: voted > 0 ? 'split' : 'voting' }
  }
  const you: WhereWeAre['you'] =
    open.length > 0
      ? { kind: 'question', count: open.length, target: open[0]!.id }
      : decision?.state === 'proposed'
        ? { kind: 'decision', target: decision.id }
        : null
  return { question: poll?.question ?? (room.prompt || room.title), lean, you }
}

export type CatchUpIcon = 'list' | 'poll' | 'scale' | 'you' | 'gavel'

export interface CatchUpItem {
  icon: CatchUpIcon
  text: string
  /** The message a click jumps to. */
  target: string
  /** It waits on Isaac: drawn in the "for you" tint. */
  you: boolean
}

export interface CatchUp {
  /** Members' messages since `from`. */
  fresh: number
  decisions: number
  /** Questions to Isaac among them still unanswered. */
  questions: number
  items: CatchUpItem[]
}

const firstName = (room: Pick<Room, 'agents'>, id: string): string =>
  room.agents.find((a) => a.id === id)?.name.split(' ')[0] ?? id

/**
 * What happened from message index `from` on: how many members' messages, decisions and open
 * questions for Isaac, and one summary line per card (plain messages folded into one line first).
 */
export function catchUp(room: Pick<Room, 'messages' | 'agents'>, from: number): CatchUp {
  const items: CatchUpItem[] = []
  const who: string[] = []
  let plain = 0
  let first: string | null = null
  let fresh = 0
  let decisions = 0
  let questions = 0
  for (const m of room.messages.slice(Math.max(0, from))) {
    if (m.author === ISAAC || m.author === ROOM_SYSTEM) continue
    fresh++
    const c = m.card
    if (!c) {
      plain++
      first ??= m.id
      if (!who.includes(m.author)) who.push(m.author)
      continue
    }
    switch (c.type) {
      case 'poll':
        items.push({ icon: 'poll', text: `Vote opened: ${c.question}`, target: m.id, you: false })
        break
      case 'proscons': {
        const disputed = [...c.pros, ...c.cons].filter((p) => p.state === 'disputed').length
        items.push({
          icon: 'scale',
          text: `Tradeoffs listed${disputed > 0 ? `, ${disputed} disputed` : ''}`,
          target: m.id,
          you: false,
        })
        break
      }
      case 'question':
        if (c.answered === undefined) questions++
        items.push({
          icon: 'you',
          text:
            c.answered === undefined
              ? `${firstName(room, c.by)} asks you: ${c.text}`
              : `You answered: ${c.answered}`,
          target: m.id,
          you: c.answered === undefined,
        })
        break
      case 'decision':
        decisions++
        items.push({
          icon: 'gavel',
          text: `Decided: ${c.title}${c.state === 'proposed' ? '. Accept or override' : ''}`,
          target: m.id,
          you: c.state === 'proposed',
        })
        break
    }
  }
  if (plain > 0 && first !== null)
    items.unshift({
      icon: 'list',
      text: `${plain} message${plain === 1 ? '' : 's'} from ${who.map((id) => firstName(room, id)).join(', ')}`,
      target: first,
      you: false,
    })
  return { fresh, decisions, questions, items }
}

/** "3 new", "1 decision", "1 question for you": the pill's parts (the last one tinted). */
export function catchUpParts(c: Pick<CatchUp, 'fresh' | 'decisions' | 'questions'>): {
  plain: string
  you: string | null
} {
  const plain = [
    `${c.fresh} new`,
    c.decisions > 0 ? `${c.decisions} decision${c.decisions === 1 ? '' : 's'}` : '',
  ]
    .filter((s) => s !== '')
    .join(' · ')
  return {
    plain,
    you: c.questions > 0 ? `${c.questions} question${c.questions === 1 ? '' : 's'} for you` : null,
  }
}

/**
 * Where "Since you left" goes: the index of the first message after `seen` (the last one Isaac
 * saw), when members said anything since; null when he saw it all or `seen` is not in the room.
 */
export function sinceIndex(
  messages: readonly RoomMessage[],
  seen: string | undefined,
): number | null {
  if (seen === undefined) return null
  const at = messages.findIndex((m) => m.id === seen)
  if (at < 0) return null
  const rest = messages.slice(at + 1)
  return rest.some((m) => m.author !== ISAAC && m.author !== ROOM_SYSTEM) ? at + 1 : null
}
