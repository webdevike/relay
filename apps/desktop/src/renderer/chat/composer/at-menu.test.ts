import { describe, expect, it } from 'vitest'
import type { SlashCommand } from '@evaos/chat-core/launch'
import { parseComputer } from '../../../main/computer/command'
import type { ChatRoomMember } from '@evaos/contract'
import {
  atQueryAt,
  atRows,
  chatAgentsAt,
  insertAgent,
  roomAgentsAt,
  splitChip,
  withChip,
} from './at-menu'

const cmd = (name: string, description = ''): SlashCommand => ({
  name,
  description,
  hint: null,
  subcommands: [],
})

describe('atRows', () => {
  const commands = [cmd('compact'), cmd('skill:adhd', 'Brainstorm'), cmd('skill:blender')]

  it('offers Computer (with modes) then skills, filtered by the typed word', () => {
    expect(atRows(commands, '').map((r) => r.key)).toEqual([
      'computer',
      'skill:adhd',
      'skill:blender',
    ])
    expect(atRows(commands, 'com').map((r) => r.key)).toEqual(['computer'])
    expect(atRows(commands, 'bl').map((r) => r.key)).toEqual(['skill:blender'])
  })

  it('inside Computer: back, then the three modes, filtered', () => {
    expect(atRows(commands, '', 'computer').map((r) => r.key)).toEqual([
      'back',
      'computer:headless',
      'computer:live',
      'computer:walk',
    ])
    expect(atRows(commands, 'wa', 'computer').map((r) => r.key)).toEqual(['back', 'computer:walk'])
  })

  const registry = [
    { id: 'nova', title: 'Nova', scope: 'Chief of staff' },
    { id: 'astra', title: 'Astra', scope: '' },
    { id: 'penny', title: 'Penny', scope: 'Errands' },
  ]

  it('lists Agents before Actions; in a chat its own assistant first', () => {
    const rows = atRows(commands, '', 'top', chatAgentsAt(registry, 'astra'))
    expect(rows.map((r) => [r.key, r.section, r.description])).toEqual([
      ['agent:astra', 'Agents', 'in this chat'],
      ['agent:nova', 'Agents', 'Chief of staff'],
      ['agent:penny', 'Agents', 'Errands'],
      ['computer', 'Actions', 'Control Mac apps on the Mini'],
      ['skill:adhd', 'Actions', 'Brainstorm'],
      ['skill:blender', 'Actions', ''],
    ])
    // Computer keeps its place among the actions whatever the agents.
    expect(atRows(commands, 'com', 'top', chatAgentsAt(registry, null)).map((r) => r.key)).toEqual([
      'computer',
    ])
    expect(atRows(commands, 'pe', 'top', chatAgentsAt(registry, null)).map((r) => r.key)).toEqual([
      'agent:penny',
    ])
  })

  it('in a room: members first, the other assistants join as guests, no actions', () => {
    const members: ChatRoomMember[] = [
      {
        id: 'nova',
        assistant: 'nova',
        name: 'Nova',
        model: 'a/b',
        thinking: 'high',
        role: 'Judge',
      },
      { id: 'skeptic', name: 'Skeptic', model: 'a/b', thinking: 'high', role: 'Argue against' },
    ]
    const rows = atRows(null, '', 'top', roomAgentsAt(members, registry), false)
    expect(rows.map((r) => [r.key, r.description])).toEqual([
      ['agent:nova', 'in this room'],
      ['agent:skeptic', 'in this room'],
      ['agent:astra', 'joins as guest'],
      ['agent:penny', 'Errands · joins as guest'],
    ])
    expect(rows[1]!.item).toEqual({ kind: 'agent', id: 'skeptic', name: 'Skeptic' })
  })
})

describe('chip text', () => {
  it('round-trips through a saved draft', () => {
    for (const mode of ['headless', 'live', 'walk'] as const) {
      expect(splitChip(withChip(mode, 'open Calculator'))).toEqual({
        mode,
        text: 'open Calculator',
      })
    }
    expect(splitChip('@computer live')).toEqual({ mode: null, text: '@computer live' })
  })

  it('is what the @computer parser reads, whatever the task starts with', () => {
    expect(parseComputer(withChip('live', 'open TextEdit'))).toEqual({
      kind: 'run',
      mode: 'live',
      task: 'open TextEdit',
    })
    expect(parseComputer(withChip('headless', 'live demo prep'))).toEqual({
      kind: 'run',
      mode: 'headless',
      task: 'live demo prep',
    })
  })
})

describe('atQueryAt', () => {
  it('finds an @word after whitespace or at the start, with skill punctuation', () => {
    expect(atQueryAt('open @com', 9)).toEqual({ start: 5, query: 'com' })
    expect(atQueryAt('@agent-r', 8)).toEqual({ start: 0, query: 'agent-r' })
    expect(atQueryAt('mail me@x', 9)).toBeNull()
    expect(atQueryAt('@com ', 5)).toBeNull()
  })

  it('an agent goes in as @First and a space, the caret after it', () => {
    const q = atQueryAt('hey @ma tail', 7)!
    expect(insertAgent('hey @ma tail', 7, q, 'Mara Voss')).toEqual({
      text: 'hey @Mara  tail',
      caret: 10,
    })
  })
})
