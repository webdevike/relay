import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArmCost, ArmSummary, ExperimentDetail, ExperimentRow } from '@evaos/contract'

const invoke = vi.fn()
const listeners = new Map<string, (payload: unknown) => void>()
vi.mock('../ipc', () => ({
  invoke: (...a: unknown[]) => invoke(...a),
  on: (channel: string, cb: (payload: unknown) => void) => {
    listeners.set(channel, cb)
    return () => listeners.delete(channel)
  },
}))

import { placeOf } from '@evaos/shell-core'
import { findTab } from '@evaos/shell-core'
import { tilingStore } from '../tiling/tiling-store'
import { ExperimentArmPanel } from './ExperimentArmPanel'
import { TestBenchPage } from './TestBenchPage'

const metric = (k: number, n: number) => ({
  metric: 'recall',
  split: 'holdout' as const,
  k,
  n,
  p: k / n,
  lo: 0.4,
  hi: 0.95,
})

const row = (id: string, over: Partial<ExperimentRow> = {}): ExperimentRow => ({
  id,
  date: id.slice(0, 10),
  title: id.slice(11),
  status: 'fail',
  progress: null,
  round: '5',
  arms: 3,
  headline: null,
  cost: null,
  hasSummary: false,
  updatedAt: 0,
  ...over,
})

const tok = (n: number) => ({ in: n, out: n / 2, cached: n * 2, total: n * 3.5 })

const PRICED: ArmCost = {
  tests: 40,
  tokens: { ...tok(400_000), perTestMedian: tok(10_000) },
  listUsd: { perTest: 0.25, perTestMedian: 0.2, total: 10 },
  billedUsd: { perTest: 0.1, total: 4, tests: 40 },
  byModel: [
    {
      model: 'claude-opus-4-1',
      calls: 120,
      tokensIn: 400_000,
      tokensOut: 200_000,
      tokensCached: 800_000,
      listUsd: 10,
      price: {
        pattern: 'claude-opus-4*',
        input: 15,
        output: 75,
        cachedInput: 1.5,
        source: 'https://www.anthropic.com/pricing',
        checked: '2026-10-27',
      },
    },
  ],
}

const UNPRICED: ArmCost = {
  tests: 40,
  tokens: { ...tok(200_000), perTestMedian: tok(5_000) },
  listUsd: null,
  unpriced: tok(1_000),
  unpricedReason: 'no list price for run lines without a model id',
  byModel: [
    {
      model: 'claude-opus-4-1',
      calls: 60,
      tokensIn: 199_000,
      tokensOut: 99_500,
      tokensCached: 398_000,
      listUsd: 4.9,
      price: PRICED.byModel[0]!.price,
    },
    {
      model: null,
      calls: 2,
      tokensIn: 1_000,
      tokensOut: 500,
      tokensCached: 2_000,
      listUsd: null,
      unpricedReason: 'no model id logged',
      price: null,
    },
  ],
}

const arm = (
  id: string,
  role: ArmSummary['role'],
  k: number,
  over: Partial<ArmSummary> = {},
): ArmSummary => ({
  id,
  label: `${id} arm`,
  role,
  quality: [metric(k, 20), { ...metric(k + 1, 20), split: 'dev' }],
  seconds: { median: 1.5, p90: 3.2, total: 75 },
  cost: null,
  costReason: 'deterministic tool',
  gap: { metric: 'recall', dev: (k + 1) / 20, holdout: k / 20, diff: 0.05 },
  repeatAgreement: { k: 18, n: 20, p: 0.9 },
  failures: { errors: 1, timeouts: 1, retries: 2, rate: 0.05 },
  judgeAudit: null,
  judgeAuditReason: 'no judge',
  calibration: {
    ece: 0.08,
    bins: [{ lo: 0.8, hi: 0.9, n: 10, acc: 0.7, conf: 0.85 }],
  },
  coverage: { run: 39, planned: 40, skipped: [{ case: null, reason: 'fixture broken' }] },
  casesFile: `runs/2/${id}.jsonl`,
  ...over,
})

const ROWS = [
  row('2026-10-28-live', {
    status: 'running',
    progress: { done: 12, planned: 40 },
    round: '3',
    hasSummary: true,
    cost: { tokens: 3_400_000, listUsd: 1.24, unpricedArms: 1, billedUsd: null },
    headline: {
      control: { arm: 'control', label: 'control arm', metric: metric(10, 20) },
      best: { arm: 'treatment', label: 'treatment arm', metric: metric(18, 20) },
    },
  }),
  row('2026-10-26-ui-check-bench'),
]

const SUMMARIZED: ExperimentDetail = {
  ...ROWS[0]!,
  question: 'Can precision reach 90%?',
  verdict: null,
  primary: 'recall',
  armSummaries: [
    arm('control', 'control', 10, { cost: PRICED }),
    arm('treatment', 'treatment', 18, { cost: UNPRICED }),
    arm('alt', 'treatment', 14, { cost: { perTest: 0.01, total: 0.4, unit: 'usd' } }),
  ],
  resultsMarkdown: null,
  summaryError: null,
}
const FALLBACK: ExperimentDetail = {
  ...ROWS[1]!,
  question: 'Does the checker find seeded bugs?',
  verdict: 'FAIL; hypothesis rejected.',
  primary: null,
  armSummaries: null,
  resultsMarkdown:
    '# ui-check bench: results\n\n| Metric | Control |\n|:--|:--|\n| recall T1 | 8/8 |\n',
  summaryError: null,
}

function mount(ui: React.ReactNode) {
  return render(<MantineProvider env="test">{ui}</MantineProvider>)
}

beforeEach(() => {
  invoke.mockReset()
  listeners.clear()
  invoke.mockImplementation(async (channel: string, input: { id?: string; arm?: string }) => {
    if (channel === 'experiments.list') return { ok: true, value: ROWS }
    if (channel === 'experiments.get')
      return { ok: true, value: input.id === SUMMARIZED.id ? SUMMARIZED : FALLBACK }
    if (channel === 'experiments.cases')
      return {
        ok: true,
        value: {
          file: `runs/2/${input.arm}.jsonl`,
          invalid: 0,
          truncated: false,
          reason: null,
          cases: [
            {
              case: 'shop-t1',
              split: 'holdout',
              repeat: 1,
              outcome: 'pass',
              passed: true,
              seconds: 1.2,
              error: null,
              skipped: null,
            },
            {
              case: 'feed-t4',
              split: 'dev',
              repeat: 1,
              outcome: null,
              passed: null,
              seconds: 30,
              error: 'timeout',
              skipped: null,
            },
          ],
        },
      }
    throw new Error(`unexpected ${channel}`)
  })
})

describe('TestBenchPage', () => {
  it('lists runs newest first with status, progress and headline', async () => {
    mount(<TestBenchPage place={placeOf('test-bench')} />)
    const live = await screen.findByTestId('experiment-row-2026-10-28-live')
    expect(within(live).getByTestId('experiment-status').textContent).toBe('Running12/40')
    expect(within(live).getByTestId('experiment-headline').textContent).toContain('90%')
    expect(live.getAttribute('title')).toContain('round 3')
    expect(live.textContent).not.toContain('round 3')
    const old = screen.getByTestId('experiment-row-2026-10-26-ui-check-bench')
    expect(old.textContent).toContain('No summary')
    expect(within(old).getByTestId('experiment-status').textContent).toBe('Fail')
    expect(old.textContent).toContain('No cost')
    const cost = within(live).getByTestId('experiment-cost')
    expect(cost.textContent).toContain('$1.24 list · 3.4M tok')
    expect(cost.textContent).toContain('1 arm unpriced')
  })

  it('shows tests control first and opens one in a tool tab', async () => {
    mount(<TestBenchPage place={placeOf('test-bench')} />)
    fireEvent.click(await screen.findByTestId('experiment-row-2026-10-28-live'))
    await screen.findByTestId('arms-table')
    expect(screen.getByText('Can precision reach 90%?')).toBeTruthy()
    const rows = screen.getAllByTestId(/^arm-row-/)
    expect(rows.map((r) => r.dataset.testid)).toEqual([
      'arm-row-control',
      'arm-row-treatment',
      'arm-row-alt',
    ])
    expect(rows[0]!.textContent).toContain('50%')
    expect(rows[0]!.textContent).toContain('1.5s')
    expect(rows[0]!.textContent).toContain('39/40')
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(expect.arrayContaining(['Tokens/test', 'List $/test', 'Quality/$']))
    expect(headers).not.toContain('Cost/test')
    const cells = (r: HTMLElement) =>
      within(r)
        .getAllByRole('cell')
        .map((c) => c.textContent)
    // Median 35k tokens per test, $0.25 list per test, 50% recall / $0.25 = 2.00.
    expect(cells(rows[0]!)).toEqual(expect.arrayContaining(['35.0k', '$0.250', '2.00']))
    expect(within(rows[0]!).getByTitle(/in 10000 · out 5000 · cached 20000/)).toBeTruthy()
    expect(cells(rows[1]!)).toEqual(expect.arrayContaining(['17.5k', 'unpriced', 'n/a']))
    expect(within(rows[1]!).getByText('unpriced').getAttribute('title')).toBe(
      'no list price for run lines without a model id',
    )
    expect(rows[2]!.textContent).toContain('$0.010 billed')
    fireEvent.click(rows[1]!)
    const tiling = tilingStore.getState().tiling
    expect(findTab(tiling, 'arm:2026-10-28-live/treatment')?.tab).toEqual({
      kind: 'experiment-arm',
      experiment: '2026-10-28-live',
      arm: 'treatment',
      label: 'treatment arm',
    })
    expect(tiling.focus).toBe(findTab(tiling, 'arm:2026-10-28-live/treatment')?.pane.id)
  })

  it('renders results.md and the record verdict for an experiment without summary.json', async () => {
    mount(<TestBenchPage place={placeOf('test-bench')} />)
    fireEvent.click(await screen.findByTestId('experiment-row-2026-10-26-ui-check-bench'))
    const md = await screen.findByTestId('experiment-results-md')
    expect(within(md).getByRole('table')).toBeTruthy()
    expect(screen.getByTestId('experiment-verdict').textContent).toContain(
      'FAIL; hypothesis rejected.',
    )
    fireEvent.click(screen.getByTestId('experiment-back'))
    await screen.findByTestId('experiments-list')
  })

  it('reloads when the harness changes the open experiment', async () => {
    mount(<TestBenchPage place={placeOf('test-bench')} />)
    fireEvent.click(await screen.findByTestId('experiment-row-2026-10-28-live'))
    await screen.findByTestId('arms-table')
    const gets = () => invoke.mock.calls.filter(([c]) => c === 'experiments.get').length
    const before = gets()
    await act(async () => listeners.get('experiments.changed')!({ ids: ['2026-10-28-live'] }))
    expect(gets()).toBe(before + 1)
  })
})

describe('ExperimentArmPanel', () => {
  it('shows every measurement, the reason for each missing one, and the case list', async () => {
    mount(
      <ExperimentArmPanel
        view={{
          kind: 'experiment-arm',
          experiment: '2026-10-28-live',
          arm: 'control',
          label: 'control arm',
        }}
      />,
    )
    const panel = await screen.findByTestId('experiment-arm-panel')
    await within(panel).findByRole('table', { name: 'Cases' })
    const text = panel.textContent ?? ''
    for (const expected of [
      '10/20',
      'no judge',
      '18/20 = 90%',
      'fixture broken',
      '85%',
      '1m 15s',
      'shop-t1',
      'timeout',
      'Tests costed40',
      '10.0k in / 5.0k out / 20.0k cached',
      'List $ per test (mean)$0.250',
      'List $ total$10.00',
      'Billed $ total$4.00 (40 tests)',
    ])
      expect(text).toContain(expected)
    const byModel = within(panel).getByRole('table', { name: 'Cost by model' })
    expect(byModel.textContent).toContain('claude-opus-4-1')
    expect(byModel.textContent).toContain('$10.00')
    const source = within(panel).getByTestId('cost-price-source')
    expect(source.textContent).toBe(
      'claude-opus-4-1: $15 / $75 / $1.5 per Mtok, source: www.anthropic.com (checked 2026-10-27)',
    )
    expect(within(source).getByRole('link').getAttribute('href')).toBe(
      'https://www.anthropic.com/pricing',
    )
    expect(within(panel).getByRole('table', { name: 'Calibration bins' })).toBeTruthy()
  })

  it('shows why list $ is missing and the unpriced model rows', async () => {
    mount(
      <ExperimentArmPanel
        view={{
          kind: 'experiment-arm',
          experiment: '2026-10-28-live',
          arm: 'treatment',
          label: 'treatment arm',
        }}
      />,
    )
    const panel = await screen.findByTestId('experiment-arm-panel')
    const byModel = await within(panel).findByRole('table', { name: 'Cost by model' })
    expect(panel.textContent).toContain('no list price for run lines without a model id')
    expect(panel.textContent).toContain('Unpriced tokens1.0k in / 500 out / 2.0k cached')
    expect(byModel.textContent).toContain('(no model id)')
    expect(within(byModel).getByText('unpriced').getAttribute('title')).toBe('no model id logged')
  })

  it('keeps the per test and total rows for a legacy cost', async () => {
    mount(
      <ExperimentArmPanel
        view={{ kind: 'experiment-arm', experiment: '2026-10-28-live', arm: 'alt', label: 'alt' }}
      />,
    )
    const panel = await screen.findByTestId('experiment-arm-panel')
    await within(panel).findByRole('table', { name: 'Cases' })
    expect(panel.textContent).toContain('Per test$0.010')
    expect(panel.textContent).toContain('Total$0.400')
    expect(within(panel).queryByRole('table', { name: 'Cost by model' })).toBeNull()
  })
})
