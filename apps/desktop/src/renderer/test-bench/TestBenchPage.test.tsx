/// <reference types="node" />
import { MantineProvider } from '@mantine/core'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import {
  BENCH_LIMITS,
  testBenchInvoke,
  type BenchModel,
  type BenchProgress,
  type BenchRun,
} from '@evaos/contract'
import { placeOf } from '@evaos/shell-core'
import {
  FIXTURES,
  FIXTURE_HASH,
  FIXTURE_VERSION,
  RUBRIC,
  SKILL,
  hash,
  publicEnvelope,
} from '../../main/test-bench/fixtures'
import { scoreRun } from '../../main/test-bench/scoring'
import { TestBenchPage } from './TestBenchPage'
const state = vi.hoisted(() => ({
  listener: null as ((p: BenchProgress) => void) | null,
  unsubscribe: vi.fn(),
}))
const invoke = vi.fn<(channel: string, input: unknown) => Promise<unknown>>()
vi.mock('../ipc', () => ({
  invoke: (channel: string, input: unknown) => invoke(channel, input),
  on: (_channel: string, listener: (p: BenchProgress) => void) => {
    state.listener = listener
    return state.unsubscribe
  },
}))
const models: BenchModel[] = [
  { provider: 'jev', model: 'jev-latest', profile: 'current', label: 'Jev', resolvedVersion: null },
  { provider: 'omp', model: 'exact-model', profile: 'work', label: 'Model', resolvedVersion: null },
]
const id = '11111111-1111-4111-8111-111111111111'
const beforeId = '22222222-2222-4222-8222-222222222222'
const afterId = '33333333-3333-4333-8333-333333333333'
function saved(status: BenchRun['status'] = 'completed'): BenchRun {
  const configurations = models.map((m, i) => ({
    provider: m.provider,
    model: m.model,
    profile: m.profile,
    id: String(i + 1).repeat(64),
    track: 'text-observation' as const,
    rubric: { ...RUBRIC, hash: hash(RUBRIC.text) },
    skill: { ...SKILL, hash: hash(SKILL.text) },
    limits: BENCH_LIMITS,
  }))
  const run: BenchRun = {
    version: 1,
    id,
    status,
    createdAt: '2026-10-20T00:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-10-20T00:01:00.000Z',
    fixtureVersion: FIXTURE_VERSION,
    fixtureHash: FIXTURE_HASH,
    configurations,
    errors: [],
    scores: [],
    cases: FIXTURES.map((f) => ({
      id: f.id,
      category: f.category,
      split: f.split,
      expected: f.expected,
      severity: f.severity,
      error: null,
      evidence: null,
      judgments: configurations.map((c) => ({
        configId: c.id,
        status: status === 'completed' ? 'valid' : 'unattempted',
        startedAt: null,
        durationMs: status === 'completed' ? 10 : null,
        error: null,
        answer:
          status === 'completed'
            ? {
                raw: '{"decision":"pass"}',
                decision: 'pass',
                rationale: 'Test-only verdict',
                requested: { provider: c.provider, model: c.model, profile: c.profile },
                returned: null,
                resolvedVersion: null,
                usage: null,
                cost: null,
              }
            : null,
      })),
    })),
  }
  const envelope = publicEnvelope(FIXTURES[0]!, {
    viewport: { width: 800, height: 600 },
    label: null,
    clipping: null,
    keyboard: null,
    persistence: null,
    pageText: '',
  })
  run.cases[0]!.evidence = {
    id: '44444444-4444-4444-8444-444444444444',
    envelope,
    digest: 'a'.repeat(64),
    beforeId,
    afterId,
    beforeDigest: 'b'.repeat(64),
    afterDigest: 'c'.repeat(64),
    collectedAt: run.createdAt,
    durationMs: 20,
  }
  run.scores = scoreRun(run)
  return run
}
let runs: BenchRun[]
let catalogFailure: boolean
function mount() {
  return render(
    <MantineProvider env="test">
      <TestBenchPage place={placeOf('test-bench')} />
    </MantineProvider>,
  )
}
beforeEach(() => {
  runs = []
  catalogFailure = false
  state.unsubscribe.mockClear()
  invoke.mockReset()
  invoke.mockImplementation(async (channel, input) => {
    if (channel === 'testBench.models')
      return catalogFailure
        ? { ok: false, error: { code: 'provider', message: 'Offline' } }
        : { ok: true, value: models }
    if (channel === 'testBench.list') return { ok: true, value: structuredClone(runs) }
    if (channel === 'testBench.get')
      return {
        ok: true,
        value: structuredClone(
          runs.find((r) => r.id === testBenchInvoke['testBench.get'].input.parse(input).runId),
        ),
      }
    if (channel === 'testBench.start') {
      runs = [saved('running')]
      return { ok: true, value: { runId: id } }
    }
    if (channel === 'testBench.cancel') {
      runs[0]!.status = 'cancelled'
      return { ok: true, value: { cancelled: true } }
    }
    if (channel === 'testBench.evidence')
      return { ok: true, value: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' } }
    throw new Error(`Unexpected test request ${channel}`)
  })
})
afterEach(cleanup)
describe('Test Bench behavior (test-only model doubles)', () => {
  it('keeps saved comparisons usable when discovery fails and never invents safety or cost', async () => {
    runs = [saved()]
    catalogFailure = true
    mount()
    await screen.findByText(/Model discovery: Offline/)
    expect(await screen.findByRole('table', { name: 'Configuration comparison' })).toBeTruthy()
    expect(screen.getByText('Repair: Unassessed')).toBeTruthy()
    expect(screen.getByText('Build: Unassessed')).toBeTruthy()
    expect(screen.getByText('Delegate: Unassessed')).toBeTruthy()
    fireEvent.click(screen.getByText('Inspect case evidence and verdicts'))
    expect(await screen.findByText(/cost: Unavailable/)).toBeTruthy()
    expect(screen.getByText(/alias unresolved/)).toBeTruthy()
    expect(
      screen.getByText(/Models receive identical text observations, not these images/),
    ).toBeTruthy()
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('testBench.evidence', {
        runId: id,
        evidenceId: beforeId,
      }),
    )
    expect(invoke).toHaveBeenCalledWith('testBench.evidence', { runId: id, evidenceId: afterId })
    fireEvent.click(screen.getByText('Raw verdict (bounded)'))
    expect(screen.getByText('{"decision":"pass"}')).toBeTruthy()
  })
  it('shows critical vetoes and split/category denominators rather than hiding failures in an average', async () => {
    runs = [saved()]
    mount()
    await screen.findByTestId('bench-results')
    fireEvent.click(screen.getByText('jev/jev-latest (current): scorecards and configuration'))
    expect(
      screen.getAllByText(/Critical false passes veto Inspect qualification/).length,
    ).toBeGreaterThan(0)
    expect(screen.getAllByText('Not qualified').length).toBe(2)
    expect(screen.getAllByText('Category denominators (development)').length).toBe(2)
    expect(screen.getAllByText('Category denominators (holdout)').length).toBe(2)
    expect(screen.getAllByText('Unattempted').length).toBe(6)
  })
  it('renders incomplete interrupted work and zero-denominator rates as unavailable', async () => {
    runs = [saved('interrupted')]
    mount()
    await screen.findByTestId('bench-results')
    expect(screen.getByText(/interrupted · incomplete/)).toBeTruthy()
    expect(screen.getAllByText('0/0 · unavailable').length).toBeGreaterThan(0)
    expect(screen.queryByText('Benchmark qualified')).toBeNull()
  })
  it('selects exact configurations, prevents duplicate start, receives progress and cancels only its run', async () => {
    mount()
    const user = userEvent.setup()
    const picker = await screen.findByRole('combobox', { name: 'Model configurations' })
    await waitFor(() => expect(picker).not.toBeDisabled())
    await user.click(picker)
    await user.click(await screen.findByRole('option', { name: 'jev/jev-latest (current)' }))
    await user.click(picker)
    await user.click(await screen.findByRole('option', { name: 'omp/exact-model (work)' }))
    await user.keyboard('{Escape}')
    fireEvent.click(screen.getByRole('button', { name: 'Run comparison' }))
    await screen.findByRole('button', { name: 'Cancel run' })
    expect(invoke).toHaveBeenCalledWith('testBench.start', {
      configurations: models.map(({ provider, model, profile }) => ({ provider, model, profile })),
    })
    expect(screen.getByRole('button', { name: 'Run comparison' })).toBeDisabled()
    await act(async () =>
      state.listener?.({
        runId: id,
        status: 'running',
        planned: 48,
        completed: 3,
        caseId: runs[0]!.cases[0]!.id,
        configId: runs[0]!.configurations[0]!.id,
      }),
    )
    expect(screen.getByText(/3\/48 judgments complete/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('testBench.cancel', { runId: id }))
    await screen.findByText(/cancelled · incomplete/)
  })
  it('navigation unsubscribes without cancellation and returning reconciles active state', async () => {
    runs = [saved('running')]
    const first = mount()
    await screen.findByRole('button', { name: 'Cancel run' })
    first.unmount()
    expect(state.unsubscribe).toHaveBeenCalledOnce()
    expect(invoke.mock.calls.some(([channel]) => channel === 'testBench.cancel')).toBe(false)
    mount()
    await screen.findByRole('button', { name: 'Cancel run' })
    runs[0]!.status = 'error'
    runs[0]!.errors = [
      { code: 'provider', message: 'Isolation refused', caseId: null, configId: null },
    ]
    await act(async () =>
      state.listener?.({
        runId: id,
        status: 'error',
        planned: 48,
        completed: 0,
        caseId: null,
        configId: null,
      }),
    )
    expect(await screen.findByText('provider: Isolation refused')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull()
  })
  it('empty discovery and history remain explicit', async () => {
    invoke.mockImplementation(async () => ({ ok: true, value: [] }))
    mount()
    expect(
      await screen.findByText('No models available through existing credentials.'),
    ).toBeTruthy()
    expect(screen.getByText(/No saved comparisons/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run comparison' })).toBeDisabled()
    expect(
      within(screen.getByLabelText('Capability ladder')).getByText('Inspect: Not yet assessed'),
    ).toBeTruthy()
  })
})
