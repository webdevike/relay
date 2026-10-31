import { describe, expect, it } from 'vitest'
import { makeMessage } from '@evaos/chat-core/message'
import { ASK_MARK, seedPrompt, toTurns } from './astra-sessions'

describe('reviews astra sessions', () => {
  it('seeds a new item session with her prime, memory, the item, then the question', () => {
    const seed = seedPrompt({
      prime: 'You are Astra.',
      memory: 'Isaac is on ENG-6312.',
      title: 'Astra · repo#170',
      label: 'repo#170',
      url: 'https://github.com/o/repo/pull/170',
      context: '### Pull request o/repo#170',
      question: '@Astra is it safe?',
    })
    expect(seed.startsWith('You are Astra.')).toBe(true)
    expect(seed).toContain('This session is not your main thread')
    expect(seed).toContain('"Astra · repo#170"')
    expect(seed).toContain('Isaac is on ENG-6312.')
    expect(seed.indexOf('### Pull request')).toBeLessThan(seed.lastIndexOf(ASK_MARK))
    expect(seed.endsWith(`${ASK_MARK}@Astra is it safe?`)).toBe(true)
  })

  it('shows only his words for the seed, a line per tool, and no thinking', () => {
    const turns = toTurns([
      makeMessage('u1', 'user', `prime and item${ASK_MARK}@Astra is it safe?`),
      makeMessage('t1', 'thinking', 'hmm'),
      makeMessage('x1', 'tool', 'read src/a.ts\nlots of output'),
      makeMessage('a1', 'assistant', 'Mostly. **One risk**.', { streaming: true }),
      makeMessage('a2', 'assistant', ''),
      makeMessage('u2', 'user', '@Astra which file first?'),
    ])
    expect(turns.map((t) => [t.role, t.text, t.streaming])).toEqual([
      ['user', '@Astra is it safe?', false],
      ['tool', 'read src/a.ts\nlots of output', false],
      ['assistant', 'Mostly. **One risk**.', true],
      ['user', '@Astra which file first?', false],
    ])
  })
})
