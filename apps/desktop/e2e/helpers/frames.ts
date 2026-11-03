import type { Page } from '@playwright/test'

export interface Percentiles {
  p50: number
  p95: number
  p99: number
  max: number
  n: number
}

declare global {
  interface Window {
    __fr?: number[]
    __frStop?: boolean
    __laf?: number[]
  }
}

/** Starts a requestAnimationFrame delta sampler (ms between frames) in the page. */
export async function startFrameSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__fr = []
    window.__frStop = false
    let last = performance.now()
    const f = (t: number): void => {
      window.__fr!.push(t - last)
      last = t
      if (!window.__frStop) requestAnimationFrame(f)
    }
    requestAnimationFrame(f)
  })
}

/** Stops the sampler and returns the raw deltas. */
export async function stopFrameSampler(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    window.__frStop = true
    await new Promise((r) => setTimeout(r, 50))
    return window.__fr ?? []
  })
}

/** Long animation frame durations (ms) seen since the observer was installed. */
export async function installLongFrameObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__laf = []
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__laf!.push(e.duration)
      }).observe({ type: 'long-animation-frame', buffered: false })
    } catch {
      /* not supported */
    }
  })
}

export async function longAnimationFrames(page: Page): Promise<number[]> {
  return page.evaluate(() => window.__laf ?? [])
}

/** Drops the first 10 samples (warm-up), then index floor(n * q) of the sorted rest. */
export function percentiles(samples: number[]): Percentiles {
  const s = samples.slice(10).sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return { p50: 0, p95: 0, p99: 0, max: 0, n: 0 }
  const at = (q: number): number => s[Math.min(n - 1, Math.floor(n * q))]!
  const r = (x: number): number => Math.round(x * 100) / 100
  return { p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(s[n - 1]!), n }
}
