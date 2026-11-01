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

  it("times turns by omp's clock, else first seen, and a tool by its turn", () => {
    const seen = new Map<string, number>()
    const rows = [
      makeMessage('u1', 'user', '@Astra is it safe?', { at: 1_000 }),
      makeMessage('x1', 'tool', 'read src/a.ts'),
      makeMessage('a1', 'assistant', 'Mostly', { streaming: true }),
    ]
    expect(toTurns(rows, seen, 5_000).map((t) => t.at)).toEqual([1_000, 1_000, 5_000])
    // The streaming answer keeps the time it was first seen.
    expect(toTurns(rows, seen, 9_000).map((t) => t.at)).toEqual([1_000, 1_000, 5_000])
    // A saved session without a clock leaves untimed rows untimed.
    expect(toTurns([makeMessage('a2', 'assistant', 'Hi')]).map((t) => t.at)).toEqual([undefined])
  })

  it('cuts her tap-to-answer replies line, also while it streams in', () => {
    const ask = 'Post it Friday?\n\n[[replies: Use that reply | Suggest a specific day]]'
    expect(toTurns([makeMessage('a1', 'assistant', ask)])[0]!.text).toBe('Post it Friday?')
    for (const tail of ['[[rep', '[[replies: Use that']) {
      const m = makeMessage('a2', 'assistant', `Post it Friday?\n${tail}`, { streaming: true })
      expect(toTurns([m])[0]!.text).toBe('Post it Friday?')
    }
    // A reply that was only the token shows nothing.
    expect(toTurns([makeMessage('a3', 'assistant', '[[replies: A | B]]')])).toEqual([])
  })
})
