import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a), on: () => () => {} }))
const show = vi.fn()
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))

import {
  closeJobForm,
  jobsStore,
  loadJobs,
  openJobForm,
  resetJobsForTests,
  setJobEnabled,
} from './jobs-store'

const job = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: null,
  every: '2h',
  enabled: true,
  scheduled: true,
  maxRun: null,
  keep: null,
  lastRunAt: 1000,
  runState: 'ok',
  runStateRaw: null,
  runNote: null,
  sessionFile: null,
  nextDueAt: 5_000_000,
  hasScript: false,
  ...over,
})

beforeEach(() => {
  invoke.mockReset()
  show.mockReset()
  resetJobsForTests()
})

describe('jobsStore', () => {
  it('collapses concurrent loads into one follow-up', async () => {
    let release!: () => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ ok: true, value: { now: 1, jobs: [job('a')] } })
        }),
    )
    invoke.mockResolvedValue({ ok: true, value: { now: 2, jobs: [job('a'), job('b')] } })
    const p = loadJobs()
    void loadJobs()
    void loadJobs()
    release()
    await p
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(jobsStore.getState().list).toHaveLength(2)
  })

  it('flags an error when the read fails', async () => {
    invoke.mockResolvedValue({ ok: false, error: { code: 'internal', message: 'x' } })
    await loadJobs()
    expect(jobsStore.getState()).toMatchObject({ error: true, loading: false, list: null })
  })

  it('setJobEnabled is optimistic and reverts with a toast on refusal', async () => {
    jobsStore.setState({ list: [job('a') as never], loading: false })
    let release!: (v: unknown) => void
    invoke.mockImplementationOnce(() => new Promise((r) => (release = r)))
    invoke.mockResolvedValue({ ok: true, value: { now: 1, jobs: [job('a')] } })
    const p = setJobEnabled('a', false)
    expect(jobsStore.getState().list![0]!.enabled).toBe(false)
    release({ ok: false, error: { code: 'not-found', message: 'x' } })
    await p
    expect(jobsStore.getState().list![0]!.enabled).toBe(true)
    expect(show).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('jobs.setEnabled', { name: 'a', enabled: false })
  })

  it('form state opens and closes', () => {
    openJobForm({ mode: 'edit', name: 'a' })
    expect(jobsStore.getState().form).toEqual({ mode: 'edit', name: 'a' })
    closeJobForm()
    expect(jobsStore.getState().form).toBeNull()
  })
})
