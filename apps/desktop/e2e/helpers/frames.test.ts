import { describe, expect, it } from 'vitest'
import { percentiles } from './frames'

describe('percentiles', () => {
  it('drops the first 10 samples and uses index floor(n*q)', () => {
    const warm = Array.from({ length: 10 }, () => 999)
    const body = Array.from({ length: 100 }, (_, i) => i + 1)
    const p = percentiles([...warm, ...body])
    expect(p).toEqual({ p50: 51, p95: 96, p99: 100, max: 100, n: 100 })
  })
  it('handles empty input', () => {
    expect(percentiles([1, 2, 3]).n).toBe(0)
  })
})
