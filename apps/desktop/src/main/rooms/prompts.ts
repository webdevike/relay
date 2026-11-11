import { ROOM_ISAAC, ROOM_JUDGE, ROOM_SYSTEM, type Room, type RoomMessage } from '@evaos/contract'

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

/** `[m12] Mara: text` lines for a slice of the transcript. */
export function transcriptLines(room: Room, messages: readonly RoomMessage[]): string {
  return messages
    .map((m) => {
      const re =
        m.reactions.length > 0
          ? `  (${m.reactions.map((r) => `${r.emoji} ${r.by.map((b) => authorName(room, b)).join(', ')}`).join('; ')})`
          : ''
      return `[${m.id}] ${authorName(room, m.author)}: ${m.text}${re}`
    })
    .join('\n')
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
