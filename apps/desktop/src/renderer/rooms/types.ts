/** Isaac's author id in a room; every other author is a RoomAgent id. */
export const ISAAC = 'isaac'

export interface RoomAgent {
  id: string
  name: string
  /** One line on what the persona argues for, shown muted next to the name. */
  role: string
  /** The model label, e.g. "claude-sonnet". */
  model: string
  /** A Mantine theme color name, e.g. "orange". */
  color: string
}

export interface RoomReaction {
  emoji: string
  /** Author ids, `isaac` included, in the order they reacted. */
  by: string[]
}

export interface RoomMessage {
  id: string
  /** `isaac` or an agent id. */
  author: string
  text: string
  ts: number
  reactions: RoomReaction[]
  /** A summary is the pinned decision that closes the room. */
  kind: 'message' | 'summary'
}

export type RoomStatus = 'live' | 'resolved'

export interface Room {
  id: string
  title: string
  prompt: string
  agents: RoomAgent[]
  messages: RoomMessage[]
  /** Agent ids typing right now. */
  typing: string[]
  status: RoomStatus
  startedAt: number
  resolvedAt?: number
}
