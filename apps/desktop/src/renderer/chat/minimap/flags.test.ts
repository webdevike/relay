import { describe, expect, it } from 'vitest'
import { announcesShipped, asksQuestion, plain, replyFlags } from './flags'

describe('asksQuestion', () => {
  it('is true for a reply ending in a question, through markdown and emoji', () => {
    expect(asksQuestion('Tests pass. Push it?')).toBe(true)
    expect(asksQuestion('Done.\n\n**Want me to push it?**')).toBe(true)
    expect(asksQuestion('Should I go on? 🙂')).toBe(true)
    expect(asksQuestion('Ship it (or hold)?')).toBe(true)
  })
  it('is true for tap-to-answer replies even without a question mark', () => {
    expect(asksQuestion('Pick one.\n[[replies: Yes, push it | Not yet]]')).toBe(true)
  })
  it('is false for statements, a lone reply answer and a question only mid-text', () => {
    expect(asksQuestion('All done.')).toBe(false)
    expect(asksQuestion('Ok?\n[[replies: Yes]]')).toBe(false)
    expect(asksQuestion('Is it fast? Yes, very.')).toBe(false)
    expect(asksQuestion('')).toBe(false)
  })
  it('ignores a question mark inside a code block or a URL query', () => {
    expect(asksQuestion('Run this:\n```\nwhat is $x?\n```')).toBe(false)
    expect(asksQuestion('See https://example.com/search?')).toBe(false)
  })
  it('reads past a leading surface tag', () => {
    expect(asksQuestion('<surface>chat</surface>\nReady to merge?')).toBe(true)
  })
})

describe('announcesShipped', () => {
  it.each([
    'The new rail is live.',
    'It shipped an hour ago.',
    'Restart Relay to pick it up.',
    'The build is ready to try.',
    'Staging is ready.',
    'Deployed to prod.',
    'Open https://relay.example.com/update/42 to install.',
    'Try the preview: https://abc.pages.dev/x',
  ])('is true for %j', (text) => {
    expect(announcesShipped(text)).toBe(true)
  })
  it.each([
    'Working on it.',
    'It is not live yet.',
    'I will restart the server after the tests.',
    "Once it's live I will tell you.",
    'Wait until it is ready.',
    'If it is ready we ship.',
    'Run:\n```\nbun restart\n```',
  ])('is false for %j', (text) => {
    expect(announcesShipped(text)).toBe(false)
  })
})

describe('plain', () => {
  it('flattens markdown, links and the replies token to one line', () => {
    const text = '# Title\n\nSee [the PR](https://x.test/1) and **run** `it`.\n\n[[replies: A | B]]'
    expect(plain(text)).toBe('Title See the PR and run it.')
  })
  it('drops fenced code and cuts long text with an ellipsis', () => {
    expect(plain('Before\n```\ncode\n```\nAfter')).toBe('Before After')
    const cut = plain('word '.repeat(200), 40)
    expect(cut.length).toBeLessThanOrEqual(40)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('replyFlags', () => {
  it('reports both at once', () => {
    expect(replyFlags('It is live. Want a tour?')).toEqual({ ask: true, shipped: true })
  })
})
