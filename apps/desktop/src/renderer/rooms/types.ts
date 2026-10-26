import type {
  Room as RoomDto,
  RoomAgent as RoomAgentDto,
  RoomMessage,
  RoomPhase,
  RoomReaction,
} from '@evaos/contract'
import { ROOM_ISAAC } from '@evaos/contract'

/** Isaac's author id in a room; every other author is a RoomAgent id, `judge` or `system`. */
export const ISAAC = ROOM_ISAAC

/** Main's agent plus the portrait the renderer draws for it. */
export interface RoomAgent extends RoomAgentDto {
  /** An SVG data URI portrait, generated offline. */
  avatar: string
}

export type { RoomMessage, RoomPhase, RoomReaction }

/** Main's room with portraits on its people. */
export interface Room extends Omit<RoomDto, 'agents'> {
  agents: RoomAgent[]
}
