import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '@evaos/contract'
import {
  MAX_SCALE,
  boardImages,
  clampPan,
  fitScale,
  fitView,
  panBy,
  step,
  wheelFactor,
  zoomTo,
} from './lightbox-model'

const node = (id: string, type: CanvasNode['type'], data?: CanvasNode['data']): CanvasNode =>
  ({ id, type, data }) as CanvasNode

const img = { width: 2000, height: 1000 }
const stage = { width: 1000, height: 800 }

describe('lightbox model', () => {
  it('lists image nodes with a source in board order', () => {
    const specs = [
      node('a', 'image', { src: 'a.png', title: 'A', caption: 'first' }),
      node('n', 'note', { title: 'note' }),
      node('empty', 'image', { title: 'no src' }),
      node('b', 'image', { src: 'b.png' }),
    ]
    expect(boardImages(specs)).toEqual([
      { id: 'a', src: 'a.png', title: 'A', caption: 'first' },
      { id: 'b', src: 'b.png', title: '', caption: '' },
    ])
  })

  it('steps within the list without wrapping', () => {
    expect(step(0, -1, 3)).toBe(0)
    expect(step(0, 1, 3)).toBe(1)
    expect(step(2, 1, 3)).toBe(2)
    expect(step(5, -1, 3)).toBe(2)
    expect(step(0, 1, 0)).toBe(0)
  })

  it('fits large images to the stage and never enlarges small ones', () => {
    expect(fitScale(img, stage)).toBe(0.5)
    expect(fitScale({ width: 400, height: 1600 }, stage)).toBe(0.5)
    expect(fitScale({ width: 100, height: 50 }, stage)).toBe(1)
    expect(fitScale(img, { width: 0, height: 0 })).toBe(1)
    expect(fitView(img, stage)).toEqual({ scale: 0.5, x: 0, y: 0 })
  })

  it('zooms between fit and the maximum, keeping the pointed spot still', () => {
    const fit = fitView(img, stage)
    // Zooming out past fit holds at fit.
    expect(zoomTo(fit, 0.1, img, stage)).toEqual(fit)
    expect(zoomTo(fit, 100, img, stage).scale).toBe(MAX_SCALE)
    // At 1:1 around a point 200px right of center: that image point stays under the pointer.
    const at = { x: 200, y: 0 }
    const one = zoomTo(fit, 1, img, stage, at)
    expect(one.scale).toBe(1)
    // Image point under the pointer before: (200 - 0) / 0.5 = 400 from center; after: (200 - x) / 1.
    expect((at.x - one.x) / one.scale).toBe((at.x - fit.x) / fit.scale)
    expect(one.x).toBe(-200)
  })

  it('pans only as far as the image covers the stage', () => {
    const one = { scale: 1, x: 0, y: 0 }
    // 2000x1000 at 1:1 in 1000x800: 500px of room each side horizontally, 100 vertically.
    expect(panBy(one, 900, 900, img, stage)).toEqual({ scale: 1, x: 500, y: 100 })
    expect(panBy(one, -50, 20, img, stage)).toEqual({ scale: 1, x: -50, y: 20 })
    // A fit image stays centered.
    expect(clampPan({ scale: 0.5, x: 40, y: -40 }, img, stage)).toEqual({ scale: 0.5, x: 0, y: 0 })
  })

  it('zooms in for upward wheels, faster for a pinch', () => {
    expect(wheelFactor(-100, false)).toBeGreaterThan(1)
    expect(wheelFactor(100, false)).toBeLessThan(1)
    expect(wheelFactor(-10, true)).toBeCloseTo(wheelFactor(-50, false))
    expect(wheelFactor(0, false)).toBe(1)
  })
})
