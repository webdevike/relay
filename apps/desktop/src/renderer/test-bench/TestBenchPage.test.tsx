import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArmSummary, ExperimentDetail, ExperimentRow } from '@evaos/contract'

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
import { layoutStore } from '../shell/layout-store'
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
  hasSummary: false,
  updatedAt: 0,
  ...over,
})

const arm = (id: string, role: ArmSummary['role'], k: number): ArmSummary => ({
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
})

const ROWS = [
  row('2026-10-28-live', {
    status: 'running',
    progress: { done: 12, planned: 40 },
    round: '3',
    hasSummary: true,
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
  armSummaries: [arm('control', 'control', 10), arm('treatment', 'treatment', 18)],
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
    expect(live.textContent).toContain('round 3')
    const old = screen.getByTestId('experiment-row-2026-10-26-ui-check-bench')
    expect(old.textContent).toContain('No summary')
    expect(within(old).getByTestId('experiment-status').textContent).toBe('Fail')
  })

  it('shows tests control first and opens one in the side panel', async () => {
    mount(<TestBenchPage place={placeOf('test-bench')} />)
    fireEvent.click(await screen.findByTestId('experiment-row-2026-10-28-live'))
    await screen.findByTestId('arms-table')
    expect(screen.getByText('Can precision reach 90%?')).toBeTruthy()
    const rows = screen.getAllByTestId(/^arm-row-/)
    expect(rows.map((r) => r.dataset.testid)).toEqual(['arm-row-control', 'arm-row-treatment'])
    expect(rows[0]!.textContent).toContain('50%')
    expect(rows[0]!.textContent).toContain('1.5s')
    expect(rows[0]!.textContent).toContain('39/40')
    fireEvent.click(rows[1]!)
    expect(layoutStore.getState().panelOpen).toBe(true)
    expect(layoutStore.getState().panelView).toEqual({
      kind: 'experiment-arm',
      experiment: '2026-10-28-live',
      arm: 'treatment',
      label: 'treatment arm',
    })
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
      'deterministic tool',
      'no judge',
      '18/20 = 90%',
      'fixture broken',
      '85%',
      '1m 15s',
      'shop-t1',
      'timeout',
    ])
      expect(text).toContain(expected)
    expect(within(panel).getByRole('table', { name: 'Calibration bins' })).toBeTruthy()
  })
})
