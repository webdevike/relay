import type { RoomPresence } from '@evaos/contract'
import { authorOf, firstName } from './RoomMessageRow'
import type { Room } from './types'

export interface PresenceGroup {
  state: RoomPresence['state']
  /** "Mara is thinking", "Theo is reading main/index.ts", "Sam and Priya are typing". */
  label: string
  /** Who the line is about, in order. */
  ids: string[]
}

/** "Mara", "Mara and Priya", "Mara, Priya and Sam". */
const names = (list: string[]): string =>
  list.length <= 1
    ? (list[0] ?? '')
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`

/**
 * One line per state, in the order thinking, reading, typing. Readers with a detail each get
 * their own line ("Theo is reading main/index.ts"); readers without one share a line.
 */
export function presenceGroups(room: Room): PresenceGroup[] {
  const by: Record<RoomPresence['state'], string[]> = { thinking: [], reading: [], typing: [] }
  const out: PresenceGroup[] = []
  const name = (id: string): string => firstName(authorOf(room.agents, id))
  for (const [id, p] of Object.entries(room.presence)) {
    if (p.state === 'reading' && p.detail)
      out.push({ state: 'reading', label: `${name(id)} is ${p.detail}`, ids: [id] })
    else by[p.state].push(id)
  }
  const groups: PresenceGroup[] = []
  for (const state of ['thinking', 'reading', 'typing'] as const) {
    const list = by[state]
    if (list.length > 0) {
      groups.push({
        state,
        label: `${names(list.map(name))} ${list.length === 1 ? 'is' : 'are'} ${state}`,
        ids: list,
      })
    }
    if (state === 'reading') groups.push(...out)
  }
  return groups
}

/** The whole presence line as one sentence, for aria-live and tests. */
export function presenceLabel(room: Room): string | null {
  const groups = presenceGroups(room)
  return groups.length === 0 ? null : groups.map((g) => g.label).join(', ')
}
