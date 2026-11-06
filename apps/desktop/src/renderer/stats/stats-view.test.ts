import { describe, expect, it } from 'vitest'
import type { StatsModel, StatsRange, StatsTotals } from '@evaos/contract'
import { folderLabel, headAndTail, insights, money, percent } from './stats-view'

const totals = (o: Partial<StatsTotals> = {}): StatsTotals => ({
  requests: 0,
  failed: 0,
  costUsd: 0,
  unpriced: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cacheSavingsUsd: 0,
  avgTtftMs: null,
  tokensPerSecond: null,
  ...o,
})
const model = (name: string, o: Partial<StatsTotals>): StatsModel => ({
  model: name,
  provider: 'anthropic',
  ...totals(o),
})
const range = (byModel: StatsModel[], o: Partial<StatsRange> = {}): StatsRange => ({
  totals: totals({ costUsd: byModel.reduce((s, m) => s + m.costUsd, 0) }),
  series: [],
  byModel,
  byFolder: [],
  byAgent: [],
  byAgentType: [],
  ...o,
})

describe('insights', () => {
  it('leads with the costliest model and who spent most, then what fails and what is slow', () => {
    const r = range(
      [
        model('opus', { costUsd: 70, requests: 400, failed: 1, avgTtftMs: 1500 }),
        model('astra', { costUsd: 20, requests: 100, failed: 4, avgTtftMs: 4200 }),
        model('sol', { costUsd: 10, requests: 50, avgTtftMs: 900 }),
      ],
      { byAgent: [{ agent: 'nova', label: 'Nova', ...totals({ costUsd: 60, requests: 300 }) }] },
    )
    expect(insights(r).map((i) => [i.kind, i.title, i.detail])).toEqual([
      ['cost', 'opus is 70% of spend', '$70.00 over 400 requests'],
      ['agent', 'Nova spent the most', '$60.00, 60% of spend'],
      ['failing', 'astra fails 4.0% of requests', '4 of 100 ended in an error'],
      ['slow', 'astra is slowest to answer', '4.2 s to first token, sol takes 900 ms'],
    ])
  })

  it('stays quiet about failures under 1%, models with too few requests to judge, and an empty range', () => {
    const r = range([
      model('opus', { costUsd: 5, requests: 1000, failed: 9, avgTtftMs: 1500 }),
      model('rare', { costUsd: 1, requests: 5, failed: 5, avgTtftMs: 9000 }),
    ])
    expect(insights(r).map((i) => i.kind)).toEqual(['cost'])
    expect(insights(range([]))).toEqual([])
  })
})

describe('formatting', () => {
  it('names worktree folders by their own name and the hub plainly', () => {
    expect(folderLabel('-Eva')).toBe('Eva hub')
    expect(folderLabel('-Eva-work-golf-sim-backyard')).toBe('golf-sim-backyard')
    expect(folderLabel('/private-tmp-rot-smoke-ok/')).toBe('tmp/rot-smoke-ok')
    expect(folderLabel('--private-tmp--')).toBe('tmp')
    expect(folderLabel('-Documents-notes')).toBe('Documents-notes')
  })

  it('drops cents from $1,000 up and shows tiny shares as under 0.1%', () => {
    expect(money(3265.0869)).toBe('$3,265')
    expect(money(18.194)).toBe('$18.19')
    expect(percent(1, 5000)).toBe('<0.1%')
    expect(percent(0, 0)).toBe('0%')
  })
})

describe('headAndTail', () => {
  it('keeps rows of at least 1% of spend and sums everything else from the totals, rows past the cap included', () => {
    const row = (costUsd: number, requests: number, failed = 0) =>
      totals({ costUsd, requests, failed })
    // The host sent three rows; the range also had $2 the host's row cap left out.
    const { head, tail } = headAndTail(
      [row(90, 900, 9), row(7, 70), row(0.5, 30, 3)],
      row(99.5, 1050, 12),
    )
    expect(head.map((r) => r.costUsd)).toEqual([90, 7])
    expect(tail).toEqual({ costUsd: 2.5, requests: 80, failed: 3 })
    expect(headAndTail([row(10, 5)], row(10, 5)).tail).toBeNull()
  })
})
