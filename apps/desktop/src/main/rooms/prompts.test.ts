import { describe, expect, it } from 'vitest'
import { ROOM_PEOPLE } from '@evaos/contract'
import {
  REPLY_MAX,
  dedash,
  parseReply,
  parseVerdict,
  personaPrompt,
  slugOf,
  trimReply,
} from './prompts'

describe('parseReply', () => {
  it('splits react lines from the text and spots PASS', () => {
    expect(parseReply('react: m1 👍\nreact: m2 🔥\n\nFine by me.')).toEqual({
      pass: false,
      reactions: [
        { messageId: 'm1', emoji: '👍' },
        { messageId: 'm2', emoji: '🔥' },
      ],
      text: 'Fine by me.',
    })
    expect(parseReply('PASS')).toEqual({ pass: true, reactions: [], text: '' })
    expect(parseReply('react: m3 👀\npass.')).toMatchObject({ pass: true, text: '' })
    expect(parseReply('**PASS**')).toMatchObject({ pass: true })
    // A react line after text is text.
    expect(parseReply('Sure.\nreact: m1 👍').text).toBe('Sure.\nreact: m1 👍')
    expect(parseReply('AGREE')).toMatchObject({ pass: false, text: 'AGREE' })
  })

  it('turns em and en dashes into commas', () => {
    expect(dedash("Mara's right—130 items is a lot – but fine")).toBe(
      "Mara's right, 130 items is a lot, but fine",
    )
    expect(parseReply('react: m1 👍\nShip it — today.').text).toBe('Ship it, today.')
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

describe('parseVerdict', () => {
  it('reads the JSON anywhere in the reply and defaults to continue', () => {
    expect(parseVerdict('{"verdict":"converged","note":"done"}')).toEqual({
      verdict: 'converged',
      note: 'done',
    })
    expect(
      parseVerdict('Sure:\n```json\n{"verdict": "continue", "note": "Sam objects"}\n```'),
    ).toEqual({
      verdict: 'continue',
      note: 'Sam objects',
    })
    expect(parseVerdict('{"verdict":"maybe"}')).toEqual({ verdict: 'continue', note: '' })
    expect(parseVerdict('not json')).toEqual({ verdict: 'continue', note: 'not json' })
  })
})

describe('personaPrompt', () => {
  it('names the person, the role brief, the peers and the rules', () => {
    const mara = ROOM_PEOPLE[0]!
    const p = personaPrompt(mara, ROOM_PEOPLE)
    expect(
      p.startsWith('You are Mara Voss, Principal Engineer. In this room you are the Skeptic.'),
    ).toBe(true)
    expect(p).toContain(mara.brief)
    expect(p).toContain('- Theo Lindqvist, Senior Engineer (Builder)')
    expect(p).not.toContain('- Mara Voss')
    expect(p).toContain('single word PASS')
    expect(p).toContain('react: <msgId> <emoji>')
    expect(p).toContain('AGREE')
    expect(p).toContain('Never use em dashes or en dashes')
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
