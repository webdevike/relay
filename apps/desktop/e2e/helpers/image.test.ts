import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { assertNotBlank, BlankImageError, blit, luminanceStats } from './image'

function solid(w: number, h: number, rgb: [number, number, number]): PNG {
  const p = new PNG({ width: w, height: h })
  for (let i = 0; i < w * h; i++) {
    p.data[i * 4] = rgb[0]
    p.data[i * 4 + 1] = rgb[1]
    p.data[i * 4 + 2] = rgb[2]
    p.data[i * 4 + 3] = 255
  }
  return p
}

function striped(w: number, h: number): PNG {
  const p = solid(w, h, [0, 0, 0])
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.floor(x / 8) % 2 === 0) {
        const i = (y * w + x) * 4
        p.data[i] = p.data[i + 1] = p.data[i + 2] = 255
      }
    }
  }
  return p
}

describe('luminanceStats', () => {
  it('uniform image has variance under 4', () => {
    expect(luminanceStats(solid(64, 64, [23, 24, 28])).variance).toBeLessThan(4)
  })
  it('two-colour stripes have variance over 4', () => {
    expect(luminanceStats(striped(64, 64)).variance).toBeGreaterThan(4)
  })
})

describe('blit', () => {
  it('copies at an offset and clips at the edges', () => {
    const dst = solid(10, 10, [0, 0, 0])
    blit(dst, solid(4, 4, [255, 0, 0]), 2, 3)
    expect(dst.data[(3 * 10 + 2) * 4]).toBe(255)
    expect(dst.data[(2 * 10 + 2) * 4]).toBe(0)
    blit(dst, solid(6, 6, [0, 255, 0]), 8, 8)
    expect(dst.data[(9 * 10 + 9) * 4 + 1]).toBe(255)
    expect(() => blit(dst, solid(3, 3, [1, 2, 3]), -2, -2)).not.toThrow()
    expect(dst.data[0]).toBe(1)
  })
})

describe('assertNotBlank', () => {
  it('throws for a uniform image', () => {
    expect(() => assertNotBlank(solid(64, 64, [255, 255, 255]))).toThrow(BlankImageError)
  })
  it('throws when a listed rect is uniform even if the rest varies', () => {
    const img = striped(128, 64)
    blit(img, solid(40, 40, [255, 255, 255]), 80, 10)
    expect(() => assertNotBlank(img)).not.toThrow()
    expect(() => assertNotBlank(img, [{ x: 80, y: 10, width: 40, height: 40 }])).toThrow(
      BlankImageError,
    )
  })
})
