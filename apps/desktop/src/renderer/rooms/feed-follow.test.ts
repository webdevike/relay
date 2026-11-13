import { describe, expect, it } from 'vitest'
import { leftBottom } from './feed-follow'

// Pinned: 1000 px of feed in a 400 px pane, scrollTop 600.
const was = { height: 1000, client: 400 }

describe('leftBottom', () => {
  it('a post under a pinned feed is not his move', () => {
    expect(leftBottom(was, { scrollHeight: 1180, scrollTop: 600, clientHeight: 400 })).toBe(false)
  })

  it('he scrolled up, with or without a post landing since', () => {
    expect(leftBottom(was, { scrollHeight: 1000, scrollTop: 0, clientHeight: 400 })).toBe(true)
    expect(leftBottom(was, { scrollHeight: 1180, scrollTop: 0, clientHeight: 400 })).toBe(true)
    expect(leftBottom(was, { scrollHeight: 1180, scrollTop: 575, clientHeight: 400 })).toBe(true)
  })

  it('a nudge within the slack still follows', () => {
    expect(leftBottom(was, { scrollHeight: 1180, scrollTop: 576, clientHeight: 400 })).toBe(false)
  })

  it('a feed that got shorter (the typing line left) clamps scrollTop: not his move', () => {
    expect(leftBottom(was, { scrollHeight: 960, scrollTop: 560, clientHeight: 400 })).toBe(false)
  })

  it('a pane that grew or shrank is not his move', () => {
    expect(leftBottom(was, { scrollHeight: 1000, scrollTop: 500, clientHeight: 500 })).toBe(false)
    expect(leftBottom(was, { scrollHeight: 1000, scrollTop: 600, clientHeight: 340 })).toBe(false)
  })
})
