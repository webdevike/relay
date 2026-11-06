import { describe, expect, it } from 'vitest'
import type { SlashCommand } from '@evaos/chat-core/launch'
import { parseComputer } from '../../../main/computer/command'
import { atQueryAt, atRows, splitChip, withChip } from './at-menu'

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
})
