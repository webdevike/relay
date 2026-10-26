import { describe, expect, it } from 'vitest'
import { ROOM_JUDGE_MODEL } from '@evaos/contract'
import { portrait } from './avatars'
import { ISAAC_PERSON, JUDGE_PERSON, ROSTER, SYSTEM_PERSON } from './roster'

describe('roster', () => {
  it('is five people with names, titles, personas, distinct colors and offline portraits', () => {
    expect(ROSTER.map((a) => a.role)).toEqual(['Skeptic', 'Builder', 'User advocate', 'PM', 'Ops'])
    expect(new Set(ROSTER.map((a) => a.color)).size).toBe(ROSTER.length)
    for (const a of [...ROSTER, ISAAC_PERSON, JUDGE_PERSON, SYSTEM_PERSON]) {
      expect(a.name).not.toBe('')
      expect(a.avatar.startsWith('data:image/svg+xml')).toBe(true)
    }
    for (const a of ROSTER) {
      expect(a.name.split(' ')).toHaveLength(2)
      expect(a.title).not.toBe('')
      expect(a.brief.length).toBeGreaterThan(40)
      // Exact omp ids, Claude or OpenAI only.
      expect(a.model).toMatch(/^(anthropic\/claude-|openai-codex\/gpt-)/)
    }
    expect(ROOM_JUDGE_MODEL).toMatch(/^anthropic\/claude-haiku/)
    expect(ISAAC_PERSON).toMatchObject({
      id: 'isaac',
      name: 'Isaac',
      title: 'Lead Software Engineer',
    })
  })

  it('portraits are deterministic per seed', () => {
    expect(portrait('mara-voss')).toBe(portrait('mara-voss'))
    expect(portrait('mara-voss')).not.toBe(portrait('theo-lindqvist'))
  })
})
