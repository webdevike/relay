import { MantineProvider } from '@mantine/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
const show = vi.fn()
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))
const openPlace = vi.fn()
vi.mock('../navigation/navigate', () => ({ openPlace: (...a: unknown[]) => openPlace(...a) }))

import { listDirty } from '../dirty/dirty-store'
import { JobForm } from './JobForm'
import { jobsStore, openJobForm, resetJobsForTests } from './jobs-store'

const TEXT = '---\nevery: 2h\n---\nDo it\n'
const got = (text = TEXT) => ({
  ok: true,
  value: {
    name: 'nightly',
    text,
    settings: { every: '2h', enabled: true, maxRun: '', keep: '' },
    steps: 'Do it\n',
    extraKeys: [],
  },
})
const entry = (name: string, sessionFile: string | null) => ({
  name,
  description: null,
  every: '2h',
  enabled: true,
  scheduled: true,
  maxRun: null,
  keep: null,
  lastRunAt: null,
  runState: 'never' as const,
  runStateRaw: null,
  runNote: null,
  sessionFile,
  nextDueAt: null,
  hasScript: false,
})

function setup(handlers: Record<string, (i: unknown) => unknown> = {}) {
  invoke.mockImplementation(async (ch: string, input: unknown) => {
    if (handlers[ch]) return handlers[ch]!(input)
    if (ch === 'jobs.get') return got()
    if (ch === 'jobs.list') return { ok: true, value: { now: 0, jobs: [] } }
    return { ok: true, value: {} }
  })
  return render(
    <MantineProvider>
      <JobForm />
    </MantineProvider>,
  )
}
const t = (id: string) => screen.getByTestId(id)
const type = (id: string, value: string) =>
  fireEvent.change(id.startsWith('job-steps') ? t(id) : t(id), { target: { value } })

beforeEach(() => {
  invoke.mockReset()
  show.mockReset()
  openPlace.mockReset()
  resetJobsForTests()
  jobsStore.setState({ list: [entry('nightly', '/s/a.jsonl')], loading: false })
  vi.useRealTimers()
})

describe('JobForm create', () => {
  it('shows the fields and validates inline', async () => {
    openJobForm({ mode: 'create' })
    setup()
    expect(await screen.findByText('New job')).toBeTruthy()
    expect(t('job-name')).toBeTruthy()
    expect(screen.getByText('Every')).toBeTruthy()
    expect(screen.getByText('Manual')).toBeTruthy()
    expect(screen.getByText('Interval')).toBeTruthy()
    expect(screen.getByText('Max run')).toBeTruthy()
    expect(
      screen.getByText('How long the session stays open for replies. Empty uses 30m.'),
    ).toBeTruthy()
    expect(screen.getByText('Enabled')).toBeTruthy()
    expect(t('job-steps')).toBeTruthy()
    expect((t('job-save') as HTMLButtonElement).disabled).toBe(true)
    type('job-name', 'Nightly 2')
    const input = t('job-name')
    expect(screen.getByText(/Use lowercase letters, numbers and hyphens/)).toBeTruthy()
    expect(input.getAttribute('aria-describedby')).toBeTruthy()
    type('job-name', 'nightly')
    expect(screen.getByText('A job named nightly already exists.')).toBeTruthy()
    type('job-name', 'fresh')
    type('job-every', '0m')
    expect(screen.getByText('Must be more than zero.')).toBeTruthy()
    type('job-every', '15m')
    type('job-keep', '0')
    type('job-steps', 'Do the thing')
    expect((t('job-save') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('job-run-now')).toBeNull()
    expect(screen.queryByTestId('job-open-last')).toBeNull()
    expect(screen.queryByTestId('job-delete')).toBeNull()
  })

  it('labels an unnamed dirty create as Job new and clears on close', async () => {
    openJobForm({ mode: 'create' })
    setup()
    await screen.findByText('New job')
    type('job-steps', 'x')
    await waitFor(() => expect(listDirty().map((d) => d.label)).toEqual(['Job new']))
    fireEvent.click(t('job-discard'))
    await waitFor(() => expect(jobsStore.getState().form).toBeNull())
    expect(listDirty()).toEqual([])
  })
})

describe('JobForm edit', () => {
  it('saves with the loaded basis, toasts and closes', async () => {
    openJobForm({ mode: 'edit', name: 'nightly' })
    setup({ 'jobs.save': () => ({ ok: true, value: { text: TEXT, changed: true } }) })
    await waitFor(() => expect((t('job-every') as HTMLInputElement).value).toBe('2h'))
    expect((t('job-save') as HTMLButtonElement).disabled).toBe(true)
    type('job-every', '3h')
    await waitFor(() => expect((t('job-save') as HTMLButtonElement).disabled).toBe(false))
    expect(listDirty().map((d) => d.label)).toEqual(['Job nightly'])
    fireEvent.keyDown(t('job-steps'), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(jobsStore.getState().form).toBeNull())
    const call = invoke.mock.calls.find((c) => c[0] === 'jobs.save')!
    expect(call[1]).toMatchObject({
      name: 'nightly',
      mode: 'update',
      basis: TEXT,
      settings: { every: '3h' },
    })
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Saved jobs/nightly/job.md.' }),
    )
    expect(invoke.mock.calls.some((c) => c[0] === 'jobs.list')).toBe(true)
  })

  it('refuses a stale save, then reloads or keeps editing', async () => {
    openJobForm({ mode: 'edit', name: 'nightly' })
    let fresh = TEXT
    setup({
      'jobs.get': () => got(fresh),
      'jobs.save': () => ({ ok: false, error: { code: 'changed-on-disk', message: 'x' } }),
    })
    await waitFor(() => expect((t('job-every') as HTMLInputElement).value).toBe('2h'))
    type('job-max-run', '5m')
    fireEvent.click(t('job-save'))
    expect(await screen.findByText(/changed on disk since you opened it/)).toBeTruthy()
    expect((t('job-save') as HTMLButtonElement).disabled).toBe(true)
    fresh = TEXT + 'more\n'
    fireEvent.click(t('job-form-keep-editing'))
    await waitFor(() => expect(screen.queryByTestId('job-form-stale')).toBeNull())
    expect((t('job-max-run') as HTMLInputElement).value).toBe('5m')
    fireEvent.click(t('job-save'))
    await screen.findByTestId('job-form-stale')
    expect(invoke.mock.calls.filter((c) => c[0] === 'jobs.save').pop()![1].basis).toBe(fresh)
    fireEvent.click(t('job-form-reload'))
    await waitFor(() => expect(screen.queryByTestId('job-form-stale')).toBeNull())
    expect((t('job-max-run') as HTMLInputElement).value).toBe('')
  })
})

describe('JobForm footer', () => {
  it('Run now starts the job and reloads later; failure toasts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    openJobForm({ mode: 'edit', name: 'nightly' })
    setup()
    await waitFor(() => expect((t('job-every') as HTMLInputElement).value).toBe('2h'))
    fireEvent.click(t('job-run-now'))
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Started nightly.' })),
    )
    expect(invoke).toHaveBeenCalledWith('jobs.run', { name: 'nightly' })
    const before = invoke.mock.calls.filter((c) => c[0] === 'jobs.list').length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(invoke.mock.calls.filter((c) => c[0] === 'jobs.list').length).toBeGreaterThan(before)
    invoke.mockImplementation(async (ch: string) =>
      ch === 'jobs.run' ? { ok: false, error: { code: 'x', message: 'x' } } : got(),
    )
    fireEvent.click(t('job-run-now'))
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Could not start nightly. Check that bun is installed and try again.',
        }),
      ),
    )
  })

  it('Open last session opens the chat place; disabled without a run', async () => {
    openJobForm({ mode: 'edit', name: 'nightly' })
    setup()
    await waitFor(() => expect((t('job-every') as HTMLInputElement).value).toBe('2h'))
    fireEvent.click(t('job-open-last'))
    expect(openPlace).toHaveBeenCalledTimes(1)
    expect(openPlace.mock.calls[0]![0]).toMatchObject({ page: 'chat', chat: '/s/a.jsonl' })
    expect(jobsStore.getState().form).toBeNull()
  })

  it('Open last session is disabled when there is no run', async () => {
    jobsStore.setState({ list: [entry('nightly', null)] })
    openJobForm({ mode: 'edit', name: 'nightly' })
    setup()
    await waitFor(() => expect((t('job-every') as HTMLInputElement).value).toBe('2h'))
    expect((t('job-open-last') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Delete asks inline with Keep focused, then deletes', async () => {
    openJobForm({ mode: 'edit', name: 'nightly' })
    setup()
    await waitFor(() => expect((t('job-every') as HTMLInputElement).value).toBe('2h'))
    fireEvent.click(t('job-delete'))
    expect(screen.getByText('Delete jobs/nightly and everything in it?')).toBeTruthy()
    expect(screen.getByText(/This removes the folder from the Eva repo/)).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(t('job-delete-keep')))
    fireEvent.click(t('job-delete-keep'))
    expect(screen.queryByTestId('job-delete-confirm')).toBeNull()
    fireEvent.click(t('job-delete'))
    fireEvent.click(t('job-delete-confirm'))
    await waitFor(() => expect(jobsStore.getState().form).toBeNull())
    expect(invoke).toHaveBeenCalledWith('jobs.delete', { name: 'nightly' })
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Deleted jobs/nightly.' }))
  })
})
