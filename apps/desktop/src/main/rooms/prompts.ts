import {
  ROOM_ISAAC,
  ROOM_JUDGE,
  ROOM_SYSTEM,
  latestCard,
  optionLabel,
  pollTally,
  type Room,
  type RoomCard,
  type RoomMessage,
} from '@evaos/contract'

/** Replies are Slack-short; anything longer is cut at a sentence boundary when one is near. */
export const REPLY_MAX = 900

export const firstName = (name: string): string => name.split(' ')[0] ?? name

/** What the room calls an author in transcript lines. */
export function authorName(room: Room, id: string): string {
  if (id === ROOM_ISAAC) return 'Isaac'
  if (id === ROOM_JUDGE) return 'Judge'
  if (id === ROOM_SYSTEM) return 'Room'
  const a = room.agents.find((x) => x.id === id)
  return a ? firstName(a.name) : id
}

/** A decision card as one bracketed note after its message's text. */
function cardNote(room: Room, card: RoomCard): string {
  switch (card.type) {
    case 'poll':
      return `[opened a poll: ${card.question} ${card.options.map((o, i) => `${i + 1}) ${o.label}`).join(' ')}]`
    case 'proscons':
      return `[listed tradeoffs on ${card.subject}]`
    case 'question':
      return `[asked Isaac: ${card.text} (${card.answers.join(' / ')})]`
    case 'decision':
      return `[made the call: ${card.title}${card.why ? `. Why: ${card.why}` : ''}${card.next ? `. Next: ${card.next.who ? `${authorName(room, card.next.who)}: ` : ''}${card.next.text}` : ''}]`
    default:
      return ''
  }
}

/** `[m12] Mara: text` lines for a slice of the transcript (a decision card as a note after it). */
export function transcriptLines(room: Room, messages: readonly RoomMessage[]): string {
  return messages
    .map((m) => {
      const re =
        m.reactions.length > 0
          ? `  (${m.reactions.map((r) => `${r.emoji} ${r.by.map((b) => authorName(room, b)).join(', ')}`).join('; ')})`
          : ''
      const card = m.card ? cardNote(room, m.card) : ''
      const body = [m.text, card].filter((s) => s !== '').join(' ')
      return `[${m.id}] ${authorName(room, m.author)}: ${body}${re}`
    })
    .join('\n')
}

/**
 * Where the room's decision cards stand now (the newest poll, tradeoffs, open questions and call),
 * for a member's turn; empty while the room has none. Votes and disputes change cards in place,
 * so this is how a member learns them.
 */
export function decisionBrief(room: Room): string {
  const names = (ids: readonly string[]): string =>
    ids.length === 0 ? 'nobody' : ids.map((id) => authorName(room, id)).join(', ')
  const lines: string[] = []
  const poll = latestCard(room, 'poll')
  if (poll) {
    const t = pollTally(poll)
    const state =
      poll.state === 'called' && poll.called
        ? `called by ${authorName(room, poll.called.by)}: ${optionLabel(poll.options, poll.called.option)}`
        : poll.state
    lines.push(
      `- Poll [${poll.id}] "${poll.question}" (${state}): ${poll.options.map((o, i) => `${i + 1}) ${o.label}: ${names(t[o.id] ?? [])}`).join('; ')}`,
    )
  }
  const pc = latestCard(room, 'proscons')
  if (pc) {
    const side = (points: typeof pc.pros): string =>
      points
        .map(
          (p) =>
            `${p.text} (${names(p.by)}${p.state === 'disputed' ? `; disputed by ${names(p.against ?? [])}` : ''})`,
        )
        .join('; ') || 'none'
    lines.push(
      `- Tradeoffs [${pc.id}] on "${pc.subject}". Pros: ${side(pc.pros)}. Cons: ${side(pc.cons)}.`,
    )
  }
  for (const m of room.messages) {
    if (m.card?.type !== 'question') continue
    if (m.card.answered === undefined)
      lines.push(`- Question for Isaac [${m.id}] "${m.card.text}": waiting for his answer`)
  }
  const d = latestCard(room, 'decision')
  if (d) {
    const state = {
      proposed: `proposed by ${authorName(room, d.by)}, waiting for Isaac to accept or override`,
      accepted: 'accepted by Isaac',
      overridden: `Isaac overrode the room's call (${d.previous ?? ''})`,
      reopened: 'reopened by Isaac: the room decides again',
    }[d.state]
    lines.push(
      `- Decision [${d.id}] "${d.title}": ${state}. Agree: ${names(d.agree)}. Dissent: ${names(d.dissent.map((x) => x.by))}.`,
    )
  }
  return lines.length === 0 ? '' : `Where the room stands:\n${lines.join('\n')}`
}

/** Em and en dashes become a comma: the house style, enforced after the model too. */
export function dedash(text: string): string {
  return text.replace(/\s*[\u2014\u2013]\s*/g, ', ')
}

/** Cuts at REPLY_MAX, at the last sentence end past the halfway mark when there is one. */
export function trimReply(text: string): string {
  if (text.length <= REPLY_MAX) return text
  const head = text.slice(0, REPLY_MAX)
  let cut = -1
  for (const re of [/[.!?]["')\]]?\s/g]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(head)) !== null) cut = m.index + m[0].length - 1
  }
  if (cut >= REPLY_MAX / 2) return head.slice(0, cut).trimEnd()
  const space = head.lastIndexOf(' ')
  return `${(space > REPLY_MAX / 2 ? head.slice(0, space) : head).trimEnd()}…`
}

/** `should-relay-auto-archive-idle-chats`: the file name part of a saved room. */
export function slugOf(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return s === '' ? 'room' : s
}
