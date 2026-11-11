import { describe, expect, it } from 'vitest'
import { REPLY_MAX, dedash, slugOf, trimReply } from './prompts'

describe('dedash', () => {
  it('turns em and en dashes into commas', () => {
    expect(dedash("Mara's right—130 items is a lot – but fine")).toBe(
      "Mara's right, 130 items is a lot, but fine",
    )
  })
})

describe('trimReply', () => {
  it('keeps short text, cuts long text at a sentence end past the halfway mark', () => {
    expect(trimReply('short')).toBe('short')
    const sentences = `${'One two three four. '.repeat(60)}`
    const out = trimReply(sentences)
    expect(out.length).toBeLessThanOrEqual(REPLY_MAX)
    expect(out.endsWith('four.')).toBe(true)
    const words = 'word '.repeat(300)
    const w = trimReply(words)
    expect(w.length).toBeLessThanOrEqual(REPLY_MAX)
    expect(w.endsWith('…')).toBe(true)
    const solid = 'x'.repeat(1200)
    expect(trimReply(solid)).toBe(`${'x'.repeat(REPLY_MAX)}…`)
  })
})

describe('slugOf', () => {
  it('is file-name safe and bounded', () => {
    expect(slugOf('Should Relay auto-archive idle chats after N days?')).toBe(
      'should-relay-auto-archive-idle-chats-after-n-days',
    )
    expect(slugOf('???')).toBe('room')
    expect(slugOf('a'.repeat(100)).length).toBe(60)
  })
})
