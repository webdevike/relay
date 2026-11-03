import { ROOM_PEOPLE, type RoomAgent as RoomAgentDto } from '@evaos/contract'
import { portrait } from '../ui/portrait'
import type { RoomAgent } from './types'

/** `mara-voss`: the portrait seed, so a person looks the same in every room. */
const seedOf = (name: string): string => name.toLowerCase().replace(/\s+/g, '-')

/** Main's agent with its portrait. */
export const withPortrait = (a: RoomAgentDto): RoomAgent => ({
  ...a,
  avatar: portrait(seedOf(a.name)),
})

/** The default people a room starts with; each a Mantine theme color so avatars stay distinct. */
export const ROSTER: readonly RoomAgent[] = ROOM_PEOPLE.map(withPortrait)

/** Isaac as a room author, the same shape as an agent so rows render alike. */
export const ISAAC_PERSON: Omit<RoomAgent, 'model' | 'brief' | 'tools'> = {
  id: 'isaac',
  name: 'Isaac',
  title: 'Lead Software Engineer',
  role: '',
  color: 'gray',
  avatar: portrait('isaac'),
}

/** The judge and the room itself post too: a verdict's summary, a dropped agent. */
export const JUDGE_PERSON: Omit<RoomAgent, 'model' | 'brief' | 'tools'> = {
  id: 'judge',
  name: 'Judge',
  title: 'Convergence judge',
  role: '',
  color: 'gray',
  avatar: portrait('judge'),
}

export const SYSTEM_PERSON: Omit<RoomAgent, 'model' | 'brief' | 'tools'> = {
  id: 'system',
  name: 'Room',
  title: '',
  role: '',
  color: 'gray',
  avatar: portrait('room'),
}
