import { portrait } from './avatars'
import type { RoomAgent } from './types'

/** The default people a room starts with; each a Mantine theme color so avatars stay distinct. */
export const ROSTER: readonly RoomAgent[] = [
  {
    id: 'skeptic',
    name: 'Mara Voss',
    title: 'Principal Engineer',
    role: 'Skeptic',
    model: 'claude-sonnet',
    color: 'orange',
    avatar: portrait('mara-voss'),
  },
  {
    id: 'builder',
    name: 'Theo Lindqvist',
    title: 'Senior Engineer',
    role: 'Builder',
    model: 'gpt-5-mini',
    color: 'blue',
    avatar: portrait('theo-lindqvist'),
  },
  {
    id: 'advocate',
    name: 'Priya Natarajan',
    title: 'Product Designer',
    role: 'User advocate',
    model: 'claude-haiku',
    color: 'teal',
    avatar: portrait('priya-natarajan'),
  },
  {
    id: 'pm',
    name: 'Jonah Reyes',
    title: 'Product Manager',
    role: 'PM',
    model: 'gpt-5',
    color: 'violet',
    avatar: portrait('jonah-reyes'),
  },
  {
    id: 'ops',
    name: 'Sam Okafor',
    title: 'Site Reliability Engineer',
    role: 'Ops',
    model: 'gemini-flash',
    color: 'green',
    avatar: portrait('sam-okafor'),
  },
]

/** Isaac as a room author, the same shape as an agent so rows render alike. */
export const ISAAC_PERSON: Omit<RoomAgent, 'model'> = {
  id: 'isaac',
  name: 'Isaac',
  title: 'Lead Software Engineer',
  role: '',
  color: 'gray',
  avatar: portrait('isaac'),
}
