/** Isaac's author id in a room; every other author is a RoomAgent id. */
export const ISAAC = 'isaac'

export interface RoomAgent {
  id: string
  /** The person's full name, e.g. "Mara Voss". */
  name: string
  /** Job title, e.g. "Principal Engineer". */
  title: string
  /** The persona behind the person: Skeptic, Builder, User advocate, PM, Ops. */
  role: string
  /** The model label, e.g. "claude-sonnet". */
  model: string
  /** A Mantine theme color name, e.g. "orange". */
  color: string
  /** An SVG data URI portrait, generated offline. */
  avatar: string
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
