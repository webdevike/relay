import { describe, expect, it } from 'vitest'
import { PIN_THRESHOLD_PX, pinReducer } from './pin'

describe('pinReducer', () => {
  it('scroll within 24 px pins and clears newReply; 25 px releases', () => {
    expect(PIN_THRESHOLD_PX).toBe(24)
    expect(pinReducer({ pinned: false, newReply: true }, { type: 'scroll', gapPx: 24 })).toEqual({
      pinned: true,
      newReply: false,
    })
    expect(pinReducer({ pinned: true, newReply: false }, { type: 'scroll', gapPx: 25 })).toEqual({
      pinned: false,
      newReply: false,
    })
  })

  it('output while unpinned sets newReply, while pinned changes nothing', () => {
    expect(pinReducer({ pinned: false, newReply: false }, { type: 'output' })).toEqual({
      pinned: false,
      newReply: true,
    })
    const pinned = { pinned: true, newReply: false }
    expect(pinReducer(pinned, { type: 'output' })).toBe(pinned)
  })

  it('jump pins and clears newReply', () => {
    expect(pinReducer({ pinned: false, newReply: true }, { type: 'jump' })).toEqual({
      pinned: true,
      newReply: false,
    })
  })

  it('scrolling while released keeps newReply', () => {
    const s = { pinned: false, newReply: true }
    expect(pinReducer(s, { type: 'scroll', gapPx: 500 })).toBe(s)
  })
})
