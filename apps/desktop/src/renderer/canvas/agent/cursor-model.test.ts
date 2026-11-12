import { describe, expect, it } from 'vitest'
import {
  EDGE_INSET,
  READ_ZOOM,
  REVEAL_INSET,
  aimOnScreen,
  easeInOut,
  revealView,
  toScreen,
  viewTarget,
} from './cursor-model'

const BOX = { x: 100, y: 50, w: 200, h: 80 }
const boxes = new Map([['a', BOX]])

describe('aimOnScreen', () => {
  it('lands on the card as drawn at the viewport: zoom scales, pan shifts', () => {
    const t = [30, -20, 2] as const
    // Card at screen (230, 80), 400 x 160.
    expect(aimOnScreen({ node: 'a' }, boxes, t)).toEqual({ x: 430, y: 160 })
    expect(aimOnScreen({ node: 'a', anchor: 'left' }, boxes, t)).toEqual({
      x: 230 + EDGE_INSET,
      y: 160,
    })
    expect(aimOnScreen({ node: 'a', anchor: 'right' }, boxes, t)).toEqual({
      x: 630 - EDGE_INSET,
      y: 160,
    })
    expect(aimOnScreen({ node: 'a', anchor: 'top' }, boxes, t)).toEqual({
      x: 430,
      y: 80 + EDGE_INSET,
    })
    expect(aimOnScreen({ node: 'a', anchor: 'bottom' }, boxes, t)).toEqual({
      x: 430,
      y: 240 - EDGE_INSET,
    })
  })

  it('keeps the edge inset in screen px, inside a card drawn small', () => {
    // Zoomed out to 0.1 the card is 20 x 8 px: the tip stays a quarter in.
    const t = [0, 0, 0.1] as const
    expect(aimOnScreen({ node: 'a', anchor: 'left' }, boxes, t)).toEqual({ x: 15, y: 9 })
    expect(aimOnScreen({ node: 'a', anchor: 'top' }, boxes, t)).toEqual({ x: 20, y: 7 })
  })

  it('aims at a flow point, and at nothing for a card the board lacks', () => {
    const t = [10, 10, 0.5] as const
    expect(aimOnScreen({ at: { x: 40, y: -20 } }, boxes, t)).toEqual({ x: 30, y: 0 })
    expect(aimOnScreen({ node: 'gone', at: { x: 0, y: 0 } }, boxes, t)).toEqual({ x: 10, y: 10 })
    expect(aimOnScreen({ node: 'gone' }, boxes, t)).toBeNull()
  })

  it('follows the board: the same aim moves with a pan and a zoom', () => {
    const before = aimOnScreen({ node: 'a' }, boxes, [0, 0, 1])!
    const after = aimOnScreen({ node: 'a' }, boxes, [-50, 25, 1.5])!
    expect(before).toEqual({ x: 200, y: 90 })
    expect(after).toEqual(toScreen({ x: 200, y: 90 }, [-50, 25, 1.5]))
  })
})

describe('viewTarget', () => {
  const vp = { x: 100, y: 50, zoom: 1 }
  const size = { w: 800, h: 600 }

  it('centers a flow point at a zoom', () => {
    const v = viewTarget(vp, size, { center: { x: 500, y: 200 }, zoom: 2 })
    expect(v).toEqual({ x: 400 - 1000, y: 300 - 400, zoom: 2 })
    // The point lands in the middle of the board.
    expect(toScreen({ x: 500, y: 200 }, [v.x, v.y, v.zoom])).toEqual({ x: 400, y: 300 })
  })

  it('zooms about the middle of what is shown, and pans by screen px', () => {
    const middle = { x: (400 - 100) / 1, y: (300 - 50) / 1 }
    const zoomed = viewTarget(vp, size, { zoom: 0.5 })
    expect(toScreen(middle, [zoomed.x, zoomed.y, zoomed.zoom])).toEqual({ x: 400, y: 300 })
    expect(viewTarget(vp, size, { pan: { dx: -120, dy: 40 } })).toEqual({ x: -20, y: 90, zoom: 1 })
  })
})

describe('revealView', () => {
  const size = { w: 800, h: 600 }
  const inset = REVEAL_INSET
  /** The box's screen rect at viewport `v`. */
  const drawn = (b: typeof BOX, v: { x: number; y: number; zoom: number }) => {
    const a = toScreen(b, [v.x, v.y, v.zoom])
    return { l: a.x, t: a.y, r: a.x + b.w * v.zoom, b: a.y + b.h * v.zoom }
  }

  it('leaves the board alone when the work already shows clear of the chrome', () => {
    expect(revealView({ x: 0, y: 40, zoom: 1 }, size, BOX)).toBeNull()
  })

  it('moves just enough to clear the chrome: a card under the zoom controls shifts right, not to the middle', () => {
    const v = revealView({ x: -60, y: 40, zoom: 1 }, size, BOX)!
    expect(v.zoom).toBe(1)
    expect(drawn(BOX, v).l).toBe(inset.left)
    expect(v.y).toBe(40)
  })

  it('brings a card past the bottom right edge in, above the cursor badge room', () => {
    const far = { x: 900, y: 700, w: 200, h: 80 }
    const r = drawn(far, revealView({ x: 0, y: 0, zoom: 1 }, size, far)!)
    expect(r.r).toBe(size.w - inset.right)
    expect(r.b).toBe(size.h - inset.bottom)
  })

  it('zooms a board zoomed out past reading up to READ_ZOOM, centered on the work', () => {
    const v = revealView({ x: 300, y: 250, zoom: 0.25 }, size, BOX)!
    expect(v.zoom).toBe(READ_ZOOM)
    const r = drawn(BOX, v)
    expect((r.l + r.r) / 2).toBeCloseTo(inset.left + (size.w - inset.left - inset.right) / 2)
  })

  it('zooms out until work wider than the board fits, never in past the zoom Isaac chose', () => {
    const wide = { x: 0, y: 0, w: 2000, h: 100 }
    const v = revealView({ x: 0, y: 0, zoom: 1 }, size, wide)!
    const r = drawn(wide, v)
    expect(r.r - r.l).toBeCloseTo(size.w - inset.left - inset.right)
    expect(r.l).toBeCloseTo(inset.left)
    // Zoomed in to 2x with the card half off the left edge: it pans, the zoom stays 2x.
    expect(revealView({ x: -200, y: 0, zoom: 2 }, size, BOX)).toMatchObject({ zoom: 2 })
  })

  it('shows the cards around the work only while that keeps it readable', () => {
    const narrow = { w: 400, h: 600 }
    const work = { x: 0, y: 0, w: 220, h: 120 }
    const near = { x: 320, y: 0, w: 220, h: 120 }
    const both = { x: 0, y: 0, w: 540, h: 120 }
    // Both cards would need zoom ~0.5 in a 400 px pane: only the work shows, at reading zoom.
    const v = revealView({ x: 0, y: 0, zoom: 0.3 }, narrow, work, both)!
    expect(v.zoom).toBe(READ_ZOOM)
    const r = drawn(work, v)
    expect(r.l).toBeGreaterThanOrEqual(inset.left)
    expect(r.r).toBeLessThanOrEqual(narrow.w - inset.right)
    // A wide pane fits both at reading zoom: both show.
    const w = revealView({ x: 0, y: 0, zoom: 0.3 }, { w: 1200, h: 600 }, work, both)!
    expect(w.zoom).toBe(READ_ZOOM)
    expect(drawn(near, w).r).toBeLessThanOrEqual(1200 - inset.right)
  })
})

describe('easeInOut', () => {
  it('starts and ends in place, symmetric about the middle', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5)
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1)
    expect(easeInOut(0.1)).toBeLessThan(0.1)
  })
})
