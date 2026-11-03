import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
const show = vi.fn()
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))

import { placeOf } from '@evaos/shell-core'
import { reloadPages, resetReloadForTests } from '../reload/reload'
import { JobsPage, runBadge } from './JobsPage'
import { jobsStore, resetJobsForTests } from './jobs-store'

const NOW = new Date(2026, 9, 15, 12, 0).getTime()
const job = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: `${name} steps`,
  every: '2h',
  enabled: true,
  scheduled: true,
  maxRun: null,
  keep: null,
  lastRunAt: NOW - 3_600_000,
  runState: 'ok',
  runStateRaw: null,
  runNote: null,
  sessionFile: null,
  nextDueAt: NOW + 3_600_000,
  hasScript: false,
  ...over,
})
const jobs = () => [
  job('nightly'),
  job('manual-check', {
    every: null,
    scheduled: false,
    nextDueAt: null,
    runState: 'never',
    lastRunAt: null,
  }),
  job('broken', { runState: 'failed' }),
]

function ui() {
  return render(
    <MantineProvider>
      <JobsPage place={placeOf('jobs')} />
    </MantineProvider>,
  )
}

beforeEach(() => {
  invoke.mockReset()
  show.mockReset()
  resetJobsForTests()
  resetReloadForTests()
})

describe('JobsPage', () => {
  it('renders the table, the badge and schedule text', async () => {
    invoke.mockResolvedValue({ ok: true, value: { now: NOW, jobs: jobs() } })
    ui()
    expect(await screen.findByTestId('job-row-nightly')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Jobs' })).toBeInTheDocument()
    expect(screen.getByTestId('jobs-scheduled')).toHaveTextContent('2 scheduled')
    for (const c of ['Name', 'Last run', 'Enabled']) {
      expect(screen.getByText(c)).toBeInTheDocument()
    }
    expect(screen.queryByText('Schedule')).toBeNull()
    expect(screen.queryByText('Next due')).toBeNull()
    const row = screen.getByTestId('job-row-nightly')
    // The schedule and next due are on hover; the description is not shown at all.
    expect(row).toHaveAttribute('title', expect.stringMatching(/^nightly\nEvery 2h · /))
    expect(within(row).queryByText('nightly steps')).toBeNull()
    expect(within(row).getByText('Every 2h')).toBeInTheDocument()
    expect(within(row).getByText('1h ago')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('job-row-manual-check')).getByText('Manual'),
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('job-row-manual-check')).getByText('Not scheduled'),
    ).toBeInTheDocument()
    expect(screen.queryByText(new RegExp('Dai' + 'ly'))).toBeNull()
  })

  it('maps run states to badges', () => {
    const base = job('x') as never as Parameters<typeof runBadge>[0]
    expect(runBadge({ ...base, runState: 'ok' })?.text).toBe('ok')
    expect(runBadge({ ...base, runState: 'failed' })).toMatchObject({
      text: 'failed',
      tone: 'warning',
    })
    expect(runBadge({ ...base, runState: 'running' })?.text).toBe('running')
    expect(runBadge({ ...base, runState: 'never', lastRunAt: null })).toMatchObject({
      text: 'never run',
      tone: 'dim',
    })
    // A script job stamps last-run but writes no run record: it ran, so never "never run".
    expect(runBadge({ ...base, runState: 'never', lastRunAt: NOW - 60_000 })).toBeNull()
    expect(runBadge({ ...base, runState: 'other', runStateRaw: 'paused' })).toMatchObject({
      text: 'paused',
      tone: 'dim',
    })
  })

  it('toggles optimistically and reverts with a toast on refusal', async () => {
    invoke.mockImplementation(async (ch: string) => {
      if (ch === 'jobs.list') return { ok: true, value: { now: NOW, jobs: jobs() } }
      return { ok: false, error: { code: 'not-found', message: 'x' } }
    })
    ui()
    const sw = (await screen.findByLabelText('Enable nightly')) as HTMLInputElement
    expect(sw.checked).toBe(true)
    fireEvent.click(sw)
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('jobs.setEnabled', { name: 'nightly', enabled: false }),
    )
    await waitFor(() => expect(show).toHaveBeenCalled())
    await waitFor(() =>
      expect((screen.getByLabelText('Enable nightly') as HTMLInputElement).checked).toBe(true),
    )
    expect(jobsStore.getState().form).toBeNull()
  })

  it('row click opens the edit form and New job opens create', async () => {
    invoke.mockResolvedValue({ ok: true, value: { now: NOW, jobs: jobs() } })
    ui()
    fireEvent.click(await screen.findByTestId('job-row-nightly'))
    expect(jobsStore.getState().form).toEqual({ mode: 'edit', name: 'nightly' })
    fireEvent.click(screen.getByTestId('jobs-new'))
    expect(jobsStore.getState().form).toEqual({ mode: 'create' })
  })

  it('shows loading, empty and error states', async () => {
    let release!: (v: unknown) => void
    invoke.mockImplementationOnce(() => new Promise((r) => (release = r)))
    const r = ui()
    expect(screen.getByText('Loading jobs')).toBeInTheDocument()
    await act(async () => release({ ok: true, value: { now: NOW, jobs: [] } }))
    expect(await screen.findByText('No jobs yet')).toBeInTheDocument()
    expect(
      screen.getByText('Create a job to have Eva run steps on a schedule.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('jobs-new')).toBeInTheDocument()
    r.unmount()

    resetJobsForTests()
    invoke.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'x' } })
    ui()
    expect(
      await screen.findByText(
        'Could not read the jobs folder. Check that jobs/ exists in the Eva repo, then press the refresh shortcut.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByTestId('jobs-retry')).toBeInTheDocument()
  })

  it('registers a reloader while mounted', async () => {
    invoke.mockResolvedValue({ ok: true, value: { now: NOW, jobs: jobs() } })
    const r = ui()
    await screen.findByTestId('job-row-nightly')
    invoke.mockClear()
    await reloadPages()
    expect(invoke).toHaveBeenCalledWith('jobs.list', {})
    r.unmount()
    invoke.mockClear()
    await reloadPages()
    expect(invoke).not.toHaveBeenCalled()
  })
})
