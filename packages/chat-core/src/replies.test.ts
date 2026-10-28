import { describe, expect, it } from 'vitest'
import { MAX_REPLIES, MAX_REPLY_CHARS, splitReplies } from './replies'

describe('splitReplies', () => {
  it('cuts a trailing token and returns its answers', () => {
    expect(
      splitReplies(
        'Ready to push?\n\n[[replies: Yes, push it | Not yet | Show me the diff]]',
        false,
      ),
    ).toEqual({ text: 'Ready to push?', replies: ['Yes, push it', 'Not yet', 'Show me the diff'] })
  })

  it('takes whitespace around the token, and none at all', () => {
    expect(splitReplies('Now?[[replies:Yes|No]]', false)).toEqual({
      text: 'Now?',
      replies: ['Yes', 'No'],
    })
    expect(splitReplies('Now? \r\n [[replies: Yes | No ]] \n\t', false)).toEqual({
      text: 'Now?',
      replies: ['Yes', 'No'],
    })
  })

  it('trims answers, collapses inner whitespace and drops empty ones', () => {
    expect(splitReplies('Which?\n[[replies:  Monday   at 9 | | Tuesday\t noon |]]', false)).toEqual(
      { text: 'Which?', replies: ['Monday at 9', 'Tuesday noon'] },
    )
  })

  it('drops answers over the length limit and keeps at most four', () => {
    expect(MAX_REPLY_CHARS).toBe(24)
    expect(MAX_REPLIES).toBe(4)
    const exact = 'x'.repeat(MAX_REPLY_CHARS)
    const long = 'y'.repeat(MAX_REPLY_CHARS + 1)
    expect(splitReplies(`Pick one\n[[replies: ${exact} | ${long} | B]]`, false).replies).toEqual([
      exact,
      'B',
    ])
    expect(splitReplies('Pick\n[[replies: A | B | C | D | E | F]]', false).replies).toEqual([
      'A',
      'B',
      'C',
      'D',
    ])
  })

  it('dedupes case-insensitively keeping the first spelling', () => {
    expect(splitReplies('Ok?\n[[replies: Yes | yes | YES | No]]', false).replies).toEqual([
      'Yes',
      'No',
    ])
  })

  it('cuts a token with fewer than two answers but returns no replies', () => {
    expect(splitReplies('Ok?\n[[replies: Yes]]', false)).toEqual({ text: 'Ok?' })
    expect(splitReplies('Ok?\n[[replies: Yes | yes]]', false)).toEqual({ text: 'Ok?' })
    expect(splitReplies('Ok?\n[[replies:]]', false)).toEqual({ text: 'Ok?' })
    expect(splitReplies(`Ok?\n[[replies: Yes | ${'z'.repeat(30)}]]`, false)).toEqual({
      text: 'Ok?',
    })
  })

  it('leaves a token in mid-text, and text with no token, alone', () => {
    const mid = 'Write [[replies: Yes | No]] at the end.'
    expect(splitReplies(mid, false)).toEqual({ text: mid })
    expect(splitReplies(mid, true)).toEqual({ text: mid })
    expect(splitReplies('Plain reply.  ', false)).toEqual({ text: 'Plain reply.  ' })
    expect(splitReplies('', true)).toEqual({ text: '' })
  })

  it('does not take a token whose answers hold a newline or a bracket', () => {
    const broken = 'Ok?\n[[replies: Yes\n| No]]'
    expect(splitReplies(broken, false)).toEqual({ text: broken })
    const bracket = 'Ok?\n[[replies: [a] | b]]'
    expect(splitReplies(bracket, false)).toEqual({ text: bracket })
  })

  it('cuts a partly arrived token while streaming, so it never flickers', () => {
    for (const tail of ['[', '[[', '[[r', '[[repl', '[[replies', '[[replies:']) {
      expect(splitReplies(`Ready to push?\n\n${tail}`, true)).toEqual({ text: 'Ready to push?' })
    }
    for (const tail of ['[[replies: Yes', '[[replies: Yes, push it | Not', '[[replies: A | B]']) {
      expect(splitReplies(`Ready to push?\n${tail}`, true)).toEqual({ text: 'Ready to push?' })
    }
  })

  it('keeps partial tokens once the reply finished streaming', () => {
    expect(splitReplies('Ready?\n[[replies: Yes', false)).toEqual({
      text: 'Ready?\n[[replies: Yes',
    })
    expect(splitReplies('Ready? [', false)).toEqual({ text: 'Ready? [' })
  })

  it('does not cut index-like text or a token broken by a newline while streaming', () => {
    expect(splitReplies('Use array[[0]] is', true)).toEqual({ text: 'Use array[[0]] is' })
    expect(splitReplies('Use array[[0', true)).toEqual({ text: 'Use array[[0' })
    expect(splitReplies('[[replies: a\nmore text', true)).toEqual({
      text: '[[replies: a\nmore text',
    })
    expect(splitReplies('Done [[replies: a]] then', true)).toEqual({
      text: 'Done [[replies: a]] then',
    })
  })

  it('takes a complete token while streaming too', () => {
    expect(splitReplies('Go?\n[[replies: Yes | No]]', true)).toEqual({
      text: 'Go?',
      replies: ['Yes', 'No'],
    })
  })
})
