import type { RoomAgent } from './types'

/** The default personas a room starts with; each a Mantine theme color so avatars stay distinct. */
export const ROSTER: readonly RoomAgent[] = [
  {
    id: 'skeptic',
    name: 'Skeptic',
    role: 'Pokes holes',
    model: 'claude-sonnet',
    color: 'orange',
  },
  {
    id: 'builder',
    name: 'Builder',
    role: 'Owns the implementation',
    model: 'gpt-5-mini',
    color: 'blue',
  },
  {
    id: 'advocate',
    name: 'User advocate',
    role: 'Speaks for Isaac',
    model: 'claude-haiku',
    color: 'teal',
  },
  {
    id: 'pm',
    name: 'PM',
    role: 'Drives to a decision',
    model: 'gpt-5',
    color: 'violet',
  },
  {
    id: 'ops',
    name: 'Ops',
    role: 'Runs it in production',
    model: 'gemini-flash',
    color: 'green',
  },
]
