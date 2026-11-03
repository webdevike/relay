import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { notifications } from '@mantine/notifications'
import type { JobSummaryDto } from '@evaos/contract'
import { everyMs } from '@evaos/eva-core/model/jobs'
import { invoke } from '../ipc'

export type JobForm = { mode: 'create' } | { mode: 'edit'; name: string } | null

export interface JobsState {
  list: JobSummaryDto[] | null
  now: number
  loading: boolean
  error: boolean
  reloading: boolean
  form: JobForm
}

const initial = (): JobsState => ({
  list: null,
  now: Date.now(),
  loading: true,
  error: false,
  reloading: false,
  form: null,
})

export const jobsStore = createStore<JobsState>(initial)

export function useJobs<T>(selector: (s: JobsState) => T): T {
  return useStore(jobsStore, selector)
}

export const openJobForm = (form: Exclude<JobForm, null>): void => jobsStore.setState({ form })
export const closeJobForm = (): void => jobsStore.setState({ form: null })

let inflight: Promise<void> | null = null
let queued = false

async function runOnce(): Promise<void> {
  jobsStore.setState({ reloading: true })
  try {
    const r = await invoke('jobs.list', {})
    if (r.ok)
      jobsStore.setState({ list: r.value.jobs, now: r.value.now, error: false, loading: false })
    else jobsStore.setState({ error: true, loading: false })
  } catch {
    jobsStore.setState({ error: true, loading: false })
  } finally {
    jobsStore.setState({ reloading: false })
  }
}

/** One request in flight; triggers during flight collapse into exactly one follow-up. */
export function loadJobs(): Promise<void> {
  if (inflight) {
    queued = true
    return inflight
  }
  inflight = (async () => {
    try {
      do {
        queued = false
        await runOnce()
      } while (queued)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

function patch(name: string, enabled: boolean): void {
  const list = jobsStore.getState().list
  if (!list) return
  jobsStore.setState({
    list: list.map((j) =>
      j.name === name
        ? {
            ...j,
            enabled,
            scheduled: enabled && everyMs(j.every) !== null,
            nextDueAt:
              enabled && everyMs(j.every) !== null
                ? j.lastRunAt === null
                  ? 0
                  : j.lastRunAt + everyMs(j.every)!
                : null,
          }
        : j,
    ),
  })
}

/** Optimistic: flips at once, reverts with a toast when the write is refused, then reloads. */
export async function setJobEnabled(name: string, on: boolean): Promise<void> {
  const previous = jobsStore.getState().list?.find((j) => j.name === name)
  if (!previous) return
  patch(name, on)
  let ok = false
  try {
    const r = await invoke('jobs.setEnabled', { name, enabled: on })
    ok = r.ok
  } catch {
    ok = false
  }
  if (!ok) {
    patch(name, previous.enabled)
    notifications.show({
      color: 'red',
      message: `Could not change ${name}. Check that jobs/${name}/job.md exists and is writable, then try again.`,
      autoClose: 8000,
    })
  }
  void loadJobs()
}

export function resetJobsForTests(): void {
  inflight = null
  queued = false
  jobsStore.setState(initial(), true)
}
