import { describe, expect, it } from 'vitest'
import {
  CORNER,
  ago,
  anchorFor,
  awaitingAnswer,
  excerpt,
  nodeAt,
  pinPoint,
  type Box,
} from './comment-model'

const box: Box = { x: 100, y: 200, w: 300, h: 120 }

describe('where a comment goes', () => {
  it('pins inside the card at the spot, else at its top right corner, else on the board', () => {
    expect(anchorFor({ x: 160, y: 230 }, { id: 'n', box })).toEqual({ node: 'n', x: 60, y: 30 })
    // The keyboard with the pointer elsewhere, or the Comment button: the card's corner.
    const corner = { node: 'n', x: 300 - CORNER.right, y: CORNER.top }
    expect(anchorFor({ x: 900, y: 900 }, { id: 'n', box })).toEqual(corner)
    expect(anchorFor(null, { id: 'n', box })).toEqual(corner)
    expect(anchorFor({ x: 12, y: 34 }, null)).toEqual({ x: 12, y: 34 })
    expect(anchorFor(null, null)).toEqual({ x: 0, y: 0 })
  })

  it('finds the topmost card under a point', () => {
    const boxes = new Map<string, Box>([
      ['under', box],
      ['over', { x: 150, y: 220, w: 50, h: 50 }],
    ])
    expect(nodeAt({ x: 160, y: 230 }, boxes)?.id).toBe('over')
    expect(nodeAt({ x: 350, y: 300 }, boxes)?.id).toBe('under')
    expect(nodeAt({ x: 0, y: 0 }, boxes)).toBeNull()
  })

  it('places a pin on its card (following it), on its board point, and hides it when its card is gone', () => {
    const boxes = new Map<string, Box>([['n', box]])
    expect(pinPoint({ node: 'n', x: 60, y: 30 }, boxes)).toEqual({ x: 160, y: 230 })
    boxes.set('n', { ...box, x: 500 })
    expect(pinPoint({ node: 'n', x: 60, y: 30 }, boxes)).toEqual({ x: 560, y: 230 })
    expect(pinPoint({ x: 7, y: 8 }, boxes)).toEqual({ x: 7, y: 8 })
    expect(pinPoint({ node: 'gone', x: 1, y: 1 }, boxes)).toBeNull()
  })
})

describe('labels', () => {
  it('shortens to one line', () => {
    expect(excerpt('  a\n  b  ')).toBe('a b')
    expect(excerpt('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`)
  })

  it('says how long ago', () => {
    const now = 10_000_000_000
    expect(ago(now - 5_000, now)).toBe('now')
    expect(ago(now - 5 * 60_000, now)).toBe('5m')
    expect(ago(now - 3 * 3_600_000, now)).toBe('3h')
    expect(ago(now - 2 * 86_400_000, now)).toBe('2d')
    expect(ago(now + 5_000, now)).toBe('now')
  })

  it('offers Ask Nova only while a human has the last word on an open thread', () => {
    const m = (kind: 'human' | 'agent') => ({
      id: kind,
      kind,
      name: 'x',
      color: '#000',
      text: 't',
      ts: 1,
    })
    expect(awaitingAnswer({ resolved: false, messages: [m('human')] })).toBe(true)
    expect(awaitingAnswer({ resolved: false, messages: [m('human'), m('agent')] })).toBe(false)
    expect(awaitingAnswer({ resolved: true, messages: [m('human')] })).toBe(false)
    expect(awaitingAnswer({ resolved: false, messages: [] })).toBe(false)
  })
})
