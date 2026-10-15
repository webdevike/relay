import { PNG } from 'pngjs'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export class BlankImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlankImageError'
  }
}

/** Variance threshold on a 0..255 luma scale below which an image counts as blank. */
export const BLANK_VARIANCE = 4

/** Mean and variance of Rec. 601 luma, sampling every 8th pixel in both axes. */
export function luminanceStats(png: PNG, rect?: Rect): { mean: number; variance: number } {
  const x0 = Math.max(0, Math.round(rect?.x ?? 0))
  const y0 = Math.max(0, Math.round(rect?.y ?? 0))
  const x1 = Math.min(png.width, Math.round((rect?.x ?? 0) + (rect?.width ?? png.width)))
  const y1 = Math.min(png.height, Math.round((rect?.y ?? 0) + (rect?.height ?? png.height)))
  let n = 0
  let sum = 0
  let sumSq = 0
  for (let y = y0; y < y1; y += 8) {
    for (let x = x0; x < x1; x += 8) {
      const i = (y * png.width + x) * 4
      const l = 0.299 * png.data[i]! + 0.587 * png.data[i + 1]! + 0.114 * png.data[i + 2]!
      n++
      sum += l
      sumSq += l * l
    }
  }
  if (n === 0) return { mean: 0, variance: 0 }
  const mean = sum / n
  return { mean, variance: sumSq / n - mean * mean }
}

/** Copies src into dst at (x, y), clipping at the destination edges. */
export function blit(dst: PNG, src: PNG, x: number, y: number): void {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy
    if (dy < 0 || dy >= dst.height) continue
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx
      if (dx < 0 || dx >= dst.width) continue
      const si = (sy * src.width + sx) * 4
      const di = (dy * dst.width + dx) * 4
      dst.data[di] = src.data[si]!
      dst.data[di + 1] = src.data[si + 1]!
      dst.data[di + 2] = src.data[si + 2]!
      dst.data[di + 3] = src.data[si + 3]!
    }
  }
}

/** Throws when the whole image, or any listed rect, is visually uniform. */
export function assertNotBlank(png: PNG, rects: Rect[] = []): void {
  const whole = luminanceStats(png)
  if (whole.variance < BLANK_VARIANCE) {
    throw new BlankImageError(`image is blank (luma variance ${whole.variance.toFixed(2)})`)
  }
  for (const r of rects) {
    const s = luminanceStats(png, r)
    if (s.variance < BLANK_VARIANCE) {
      throw new BlankImageError(
        `view rect ${JSON.stringify(r)} is blank (luma variance ${s.variance.toFixed(2)})`,
      )
    }
  }
}
