import { describe, expect, it } from 'vitest'
import { cardModel, cardVendor, recentWork, runClock, settleFront, stepFront } from './card-stack'

describe('card stack', () => {
  it('keeps the front card while it stays, else moves to the next one that stayed, else the last', () => {
    expect(settleFront(['a', 'b', 'c'], ['new', 'a', 'b', 'c'], 'b')).toBe('b')
    expect(settleFront(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c')
    expect(settleFront(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b')
    expect(settleFront(['a', 'b', 'c'], ['x'], 'b')).toBe('x')
    expect(settleFront(['a'], [], 'a')).toBeNull()
    expect(settleFront([], ['a', 'b'], null)).toBe('a')
  })

  it('steps through the cards, wrapping only when the stack loops', () => {
    const ids = ['a', 'b', 'c']
    expect(stepFront(ids, 'c', 1, true)).toBe('a')
    expect(stepFront(ids, 'a', -1, true)).toBe('c')
    expect(stepFront(ids, 'c', 1, false)).toBe('c')
    expect(stepFront(ids, 'a', -1, false)).toBe('a')
    expect(stepFront(ids, 'a', 1, false)).toBe('b')
    expect(stepFront([], 'a', 1, true)).toBeNull()
  })

  it('reads a run clock in minutes and seconds, then hours and minutes', () => {
    expect(runClock(35 * 60_000 + 12_000)).toBe('35m 12s')
    expect(runClock(64 * 60_000 + 5_000)).toBe('1h 04m')
    expect(runClock(-5)).toBe('0m 00s')
  })

  it("names the model without its brand word, its thinking level after it, and picks the vendor's logo", () => {
    expect(cardModel('Claude Opus 5.5', 'high')).toBe('Opus 5.5 high')
    expect(cardModel('GPT-5', 'off')).toBe('GPT-5')
    expect(cardModel(undefined, 'high')).toBeNull()
    expect(cardVendor('Claude Opus 5.5')).toBe('anthropic')
    expect(cardVendor('GPT-5 Codex')).toBe('openai')
    expect(cardVendor('Mystery 1', 'openai-codex')).toBe('openai')
    expect(cardVendor('Gemini 3')).toBeNull()
  })

  it("shows the host's last four lines of work, else the latest line alone", () => {
    expect(recentWork({ log: ['a', 'b', 'c', 'd', 'e'], intent: 'e' })).toEqual([
      'b',
      'c',
      'd',
      'e',
    ])
    expect(recentWork({ intent: 'Reading the diff' })).toEqual(['Reading the diff'])
    expect(recentWork({ log: [], intent: '' })).toEqual([])
  })
})
