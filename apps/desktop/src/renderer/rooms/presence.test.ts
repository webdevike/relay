import { describe, expect, it } from 'vitest'
import { presenceGroups, presenceLabel } from './presence'
import { ROSTER } from './test-roster'
import type { Room } from './types'

const room = (presence: Room['presence']): Room => ({
  id: 'r',
  kind: 'council',
  title: 't',
  prompt: 't',
  agents: ROSTER.slice(),
  messages: [],
  presence,
  phase: 'open',
  rounds: 1,
  startedAt: 0,
})

describe('presenceGroups', () => {
  it('is empty when everyone is idle', () => {
    expect(presenceGroups(room({}))).toEqual([])
    expect(presenceLabel(room({}))).toBeNull()
  })

  it('groups by state in thinking, reading, typing order and names people by first name', () => {
    const groups = presenceGroups(
      room({
        ops: { state: 'typing', since: 1 },
        skeptic: { state: 'thinking', since: 1 },
        builder: { state: 'reading', detail: 'reading main/index.ts', since: 1 },
        advocate: { state: 'typing', since: 1 },
        pm: { state: 'reading', since: 1 },
      }),
    )
    expect(groups).toEqual([
      { state: 'thinking', label: 'Mara is thinking' },
      { state: 'reading', label: 'Jonah is reading' },
      { state: 'reading', label: 'Theo is reading main/index.ts' },
      { state: 'typing', label: 'Sam and Priya are typing' },
    ])
    expect(
      presenceLabel(
        room({
          ops: { state: 'typing', since: 1 },
          skeptic: { state: 'typing', since: 1 },
          pm: { state: 'typing', since: 1 },
        }),
      ),
    ).toBe('Sam, Mara and Jonah are typing')
  })
})
