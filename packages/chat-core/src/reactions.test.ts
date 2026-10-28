import { describe, expect, it } from 'vitest'
import { makeMessage } from './message'
import {
  MAX_REACTION_EXCERPT,
  MORE_REACTIONS,
  QUICK_REACTIONS,
  ReactionEmojiSchema,
  ReactionKeySchema,
  ReactionThreadSchema,
  ThreadReactionsSchema,
  agentReactions,
  assistantReactionThread,
  reactionExcerpt,
  reactionKey,
  reactionKeyOf,
  sessionReactionThread,
  toggleReaction,
  withIsaacReaction,
} from './reactions'

describe('reaction helpers (mirror of relay protocol "Reactions")', () => {
  it('keeps the quick picks in the protocol order, and every offered emoji is valid', () => {
    expect(QUICK_REACTIONS).toEqual(['❤️', '👍', '👎', '😂', '‼️', '❓'])
    for (const e of [...QUICK_REACTIONS, ...MORE_REACTIONS]) {
      expect(ReactionEmojiSchema.safeParse(e).success, e).toBe(true)
    }
    expect(new Set(MORE_REACTIONS).size).toBe(MORE_REACTIONS.length)
    expect(MORE_REACTIONS.some((e) => (QUICK_REACTIONS as readonly string[]).includes(e))).toBe(
      false,
    )
  })

  it('rejects text, empty and overlong emoji', () => {
    for (const bad of ['', 'a', 'ok', '1', '❤️'.repeat(20)]) {
      expect(ReactionEmojiSchema.safeParse(bad).success, bad).toBe(false)
    }
  })

  it('names threads like the host', () => {
    expect(assistantReactionThread('astra')).toBe('assistant:astra')
    expect(sessionReactionThread({ id: 's1', kind: 'assistant', assistant: 'astra' })).toBe(
      'assistant:astra',
    )
    expect(sessionReactionThread({ id: 's1', kind: 'assistant', assistant: null })).toBe(
      'session:s1',
    )
    expect(sessionReactionThread({ id: 's1', kind: 'manual', assistant: 'astra' })).toBe(
      'session:s1',
    )
    expect(ReactionThreadSchema.safeParse('assistant:astra').success).toBe(true)
    expect(ReactionThreadSchema.safeParse('session:abc-1').success).toBe(true)
    expect(ReactionThreadSchema.safeParse('assistant:Astra').success).toBe(false)
    expect(ReactionThreadSchema.safeParse('room:x').success).toBe(false)
  })

  it('keys a bubble by role and truncated omp timestamp; only stamped user/assistant rows', () => {
    expect(reactionKey('assistant', 1700.9)).toBe('assistant@1700')
    expect(ReactionKeySchema.safeParse(reactionKey('user', 5)).success).toBe(true)
    expect(reactionKeyOf(makeMessage('x', 'user', 'hi', { at: 42 }))).toBe('user@42')
    expect(reactionKeyOf(makeMessage('x', 'assistant', 'hi', { at: 43 }))).toBe('assistant@43')
    expect(reactionKeyOf(makeMessage('x', 'user', 'hi'))).toBeNull()
    expect(reactionKeyOf(makeMessage('x', 'tool', 'read', { at: 44 }))).toBeNull()
    expect(reactionKeyOf(makeMessage('x', 'thinking', 'hmm', { at: 45 }))).toBeNull()
  })

  it('toggles: the same emoji clears, another replaces', () => {
    expect(toggleReaction(null, '👍')).toBe('👍')
    expect(toggleReaction('👍', '👍')).toBeNull()
    expect(toggleReaction('👍', '❤️')).toBe('❤️')
  })

  it('cuts the excerpt to one untagged line of at most 200 characters', () => {
    expect(reactionExcerpt('<surface>Mac - Relay Desktop</surface>\nfix  the\n\ndock ')).toBe(
      'fix the dock',
    )
    const long = reactionExcerpt('x'.repeat(500))
    expect(long).toHaveLength(MAX_REACTION_EXCERPT)
  })

  it('parses a snapshot record by reaction key, then reactor', () => {
    const ok = { 'user@1': { isaac: { emoji: '👍', excerpt: 'hi', at: 2 } } }
    expect(ThreadReactionsSchema.parse(ok)).toEqual(ok)
    expect(ThreadReactionsSchema.safeParse({ 'tool@1': ok['user@1'] }).success).toBe(false)
    expect(
      ThreadReactionsSchema.safeParse({ 'user@1': { Isaac: ok['user@1'].isaac } }).success,
    ).toBe(false)
    // The old flat shape is not a reactor record.
    expect(ThreadReactionsSchema.safeParse({ 'user@1': ok['user@1'].isaac }).success).toBe(false)
  })

  it("lists a bubble's assistant reactions oldest first, Isaac's apart", () => {
    const r = (emoji: string, at: number) => ({ emoji, excerpt: '', at })
    expect(agentReactions(undefined)).toEqual([])
    expect(
      agentReactions({ isaac: r('❤️', 1), nova: r('👀', 5), astra: r('🔥', 5), bolt: r('👍', 2) }),
    ).toEqual([
      { agent: 'bolt', reaction: r('👍', 2) },
      { agent: 'astra', reaction: r('🔥', 5) },
      { agent: 'nova', reaction: r('👀', 5) },
    ])
  })

  it("sets and clears Isaac's reaction, keeping the assistants'", () => {
    const heart = { emoji: '❤️', excerpt: 'hi', at: 1 }
    const eyes = { emoji: '👀', excerpt: 'hi', at: 2 }
    expect(withIsaacReaction(undefined, heart)).toEqual({ isaac: heart })
    expect(withIsaacReaction({ astra: eyes }, heart)).toEqual({ astra: eyes, isaac: heart })
    expect(withIsaacReaction({ astra: eyes, isaac: heart }, null)).toEqual({ astra: eyes })
    expect(withIsaacReaction({ isaac: heart }, null)).toBeUndefined()
  })
})
