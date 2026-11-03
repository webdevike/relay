import { describe, expect, it } from 'vitest'
import { checkMetrics } from './check-metrics'

const good = () => ({
  display: { hz: 120 },
  chat: {
    seqGaps: 0,
    seqContiguous: true,
    gate: { budgetMs: 21 },
    idle: { p95: 17 },
    stream: { p50: 8, p95: 17, p99: 18, max: 19, longFrames: 0 },
  },
  browser: {
    boundsDeltaPx: 0,
    overlayHidesView: true,
    boundsRestoredAfterOverlay: true,
    cdpText: 'hello',
    devtoolsCoexist: true,
    extensionLoaded: true,
    arcImportCount: 3,
  },
})

describe('checkMetrics', () => {
  it('passes a complete object', () => {
    expect(checkMetrics(good())).toEqual([])
  })
  it('reports a missing key', () => {
    const m = good() as { browser: Record<string, unknown> }
    delete m.browser.cdpText
    expect(checkMetrics(m)).toContain('missing key: browser.cdpText')
  })
  it('reports a failing threshold', () => {
    const m = good()
    m.chat.stream.p95 = 30
    m.chat.stream.longFrames = 2
    const p = checkMetrics(m)
    expect(p.some((x) => x.includes('exceeds') || x.includes('> budget'))).toBe(true)
    expect(p.some((x) => x.includes('longFrames'))).toBe(true)
  })
})
