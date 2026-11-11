// Five room people for unit tests (mentions, presence): names, roles and colors only.
import { withPortrait } from './roster'
import type { RoomAgent } from './types'

const person = (id: string, name: string, role: string, color: string): RoomAgent =>
  withPortrait({
    id,
    name,
    title: role,
    role,
    brief: '',
    model: 'anthropic/claude-opus-5-5',
    tools: 'none',
    color,
  })

export const ROSTER: readonly RoomAgent[] = [
  person('skeptic', 'Mara Voss', 'Skeptic', 'orange'),
  person('builder', 'Theo Lindqvist', 'Builder', 'blue'),
  person('advocate', 'Priya Natarajan', 'User advocate', 'teal'),
  person('pm', 'Jonah Reyes', 'PM', 'violet'),
  person('ops', 'Sam Okafor', 'Ops', 'green'),
]
