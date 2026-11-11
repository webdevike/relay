// Who speaks next in a chat room. Each of Isaac's messages starts a burst: the members he
// @mentions first, then everyone else in setup order; a reply that @mentions a member hands that
// member the next turn; effort bounds the turns of one burst; a judge or chair gets the last word.
// Pure, so the engine (chat-room.ts) and its tests share it.
import { MENTION_EVERYONE, type ChatRoomMember } from '@evaos/contract'

/** Turns one of Isaac's messages may start at most, whatever the effort and the room size. */
export const MAX_BURST_TURNS = 20

/** A burst in progress: who is queued, how many turns are left, who spoke last. Saved in room.json. */
export interface Burst {
  queue: string[]
  left: number
  last: string | null
}

/** The member who closes each burst: a Judge or Chair by role, the first one when there are several. */
export const judgeOf = (members: readonly ChatRoomMember[]): string | null =>
  members.find((m) => /\b(judge|chair)\b/i.test(m.role))?.id ?? null

/** Turns of one burst: effort (1..5) turns per member, capped. */
export const turnBudget = (effort: number, members: number): number =>
  Math.max(1, Math.min(effort * members, MAX_BURST_TURNS))

/**
 * The burst Isaac's message starts: `mentioned` (member ids in the order he named them, or
 * `everyone`) first, then the other members in setup order. The judge is not queued unless he
 * named it; it speaks last.
 */
export function burstFor(
  members: readonly ChatRoomMember[],
  mentioned: readonly string[],
  effort: number,
): Burst {
  const order = members.map((m) => m.id)
  const judge = judgeOf(members)
  const first = mentioned.includes(MENTION_EVERYONE)
    ? order.filter((id) => id !== judge)
    : mentioned.filter((id) => order.includes(id))
  const rest = order.filter((id) => !first.includes(id) && id !== judge)
  return { queue: [...first, ...rest], left: turnBudget(effort, members.length), last: null }
}

/**
 * Who speaks next, or null when the burst is over. The judge takes the last turn (the queue ran
 * out, or one turn is left) unless it spoke last; members no longer in the room are skipped.
 */
export function nextSpeaker(burst: Burst, members: readonly ChatRoomMember[]): string | null {
  if (burst.left <= 0) return null
  const present = new Set(members.map((m) => m.id))
  const queue = burst.queue.filter((id) => present.has(id))
  const judge = judgeOf(members)
  const closing = queue.length === 0 || burst.left === 1
  if (judge !== null && closing && burst.last !== null && burst.last !== judge) return judge
  return queue[0] ?? null
}

/**
 * The burst after `speaker`'s reply: one turn used, the speaker off the queue, and the members
 * the reply @mentions (`handoff`, in order) next. A reply that asks Isaac (`asksIsaac`) and hands
 * off to nobody ends the burst: only Isaac can answer.
 */
export function afterTurn(
  burst: Burst,
  speaker: string,
  handoff: readonly string[],
  asksIsaac: boolean,
): Burst {
  const next = handoff.filter((id) => id !== speaker && id !== MENTION_EVERYONE)
  if (asksIsaac && next.length === 0) return { queue: [], left: 0, last: speaker }
  const rest = burst.queue.filter((id) => id !== speaker && !next.includes(id))
  return { queue: [...next, ...rest], left: burst.left - 1, last: speaker }
}
