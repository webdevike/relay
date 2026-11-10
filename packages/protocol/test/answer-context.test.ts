import { describe, expect, it } from 'vitest'
import {
  answerExcerpt,
  answerTagOf,
  answerText,
  MAX_ANSWER_CONTEXT,
  stripAnswerContext,
} from '../src/answer-context'

describe('answerText', () => {
  it('leaves an answer to the newest message bare', () => {
    expect(answerText('Skip it', 'Run the nightly job?', false)).toBe('Skip it')
  })

  it('tags an answer to an older question with the question', () => {
    expect(answerText('Skip it', 'Run the nightly job?', true)).toBe(
      '[answer to: "Run the nightly job?"] Skip it',
    )
  })

  it('flattens whitespace and quotes, and cuts a long question to the limit', () => {
    const out = answerText('Yes', `Say "go"\n\n${'word '.repeat(60)}`, true)
    const q = /^\[answer to: "(.*)"\] Yes$/.exec(out)?.[1] ?? ''
    expect(q.startsWith("Say 'go' word")).toBe(true)
    expect(q.length).toBeLessThanOrEqual(MAX_ANSWER_CONTEXT)
    expect(q.endsWith('…')).toBe(true)
  })

  it('sends a bare answer when the question is empty', () => {
    expect(answerText('Skip it', '  ', true)).toBe('Skip it')
  })
})

describe('stripAnswerContext', () => {
  it('round-trips and leaves other text alone', () => {
    const tagged = answerText('Skip it', 'Run it?', true)
    expect(stripAnswerContext(tagged)).toBe('Skip it')
    expect(stripAnswerContext('Skip it')).toBe('Skip it')
    expect(stripAnswerContext('hi [answer to: "x"] there')).toBe('hi [answer to: "x"] there')
  })
})

describe('answerTagOf', () => {
  it('reads back the question a tagged answer names, long questions included, and the words after it', () => {
    const long = `Ship "the thing"\n${'and more '.repeat(30)}?`
    const tag = answerTagOf(answerText('Ship it', long, true))
    expect(tag).toEqual({ question: answerExcerpt(long), answer: 'Ship it' })
    expect(answerTagOf('Ship it')).toBeNull()
    expect(answerTagOf('hi [answer to: "x"] there')).toBeNull()
  })
})
