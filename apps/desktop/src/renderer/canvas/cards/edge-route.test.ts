import { describe, expect, it } from 'vitest'
import {
  arrowHead,
  longestSegmentMid,
  roundedPath,
  routeEndsOnSides,
  routeMatches,
} from './edge-route'

const route = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 50 },
]

describe('edge routes', () => {
  it('rounds each corner by the radius', () => {
    expect(roundedPath(route)).toBe('M 0 0 L 90 0 Q 100 0 100 10 L 100 50')
  })

  it('shrinks the radius on short segments and skips duplicate points', () => {
    const short = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 40 },
    ]
    expect(roundedPath(short)).toBe('M 0 0 L 5 0 Q 10 0 10 5 L 10 40')
    expect(roundedPath([])).toBe('')
  })

  it('matches only while both ends sit within 3px of the anchors', () => {
    expect(routeMatches(route, [0, 0], [100, 50])).toBe(true)
    expect(routeMatches(route, [2, 2], [100, 52])).toBe(true)
    expect(routeMatches(route, [0, 0], [100, 55])).toBe(false)
    expect(routeMatches(route, [10, 0], [100, 50])).toBe(false)
    expect(routeMatches([{ x: 0, y: 0 }], [0, 0], [0, 0])).toBe(false)
  })

  it('accepts ends anywhere along the chosen sides', () => {
    const a = { x: -100, y: -20, w: 100, h: 40, side: 'right' as const }
    const b = { x: 80, y: 50, w: 60, h: 40, side: 'top' as const }
    expect(routeEndsOnSides(route, a, b)).toBe(true)
    expect(routeEndsOnSides(route, { ...a, side: 'left' }, b)).toBe(false)
    expect(routeEndsOnSides(route, a, { ...b, y: 80 })).toBe(false)
  })

  it('orients the arrowhead along the last segment', () => {
    expect(arrowHead({ x: 0, y: 0 }, { x: 20, y: 0 })).toBe('M 20 0 L 11 4 L 11 -4 Z')
    expect(arrowHead({ x: 5, y: 40 }, { x: 5, y: 0 }, 10, 6)).toBe('M 5 0 L 8 10 L 2 10 Z')
    expect(arrowHead({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe('')
  })

  it('puts the label on the middle of the longest segment', () => {
    expect(longestSegmentMid(route)).toEqual([50, 0])
  })
})
