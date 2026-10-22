import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Kbd,
  SegmentedControl,
  Switch,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconAlertTriangle } from '@tabler/icons-react'
import { placeOf } from '@evaos/shell-core'
import { JOB_COPY, type JobFieldErrors } from '@evaos/eva-core/model/jobs'
import { registerDirty } from '../dirty/dirty-store'
import { invoke } from '../ipc'
import { openPlace } from '../navigation/navigate'
import { EvaModal } from '../overlay'
import {
  formErrors,
  initialForm,
  isDirty,
  mergeFresh,
  toSaveInput,
  type JobFormState,
  type ScheduleMode,
} from './job-form-model'
import { closeJobForm, jobsStore, loadJobs, useJobs } from './jobs-store'
import './job-form.css'

const TIP_Z = 400

interface Loaded {
  basis: string | null
  initial: JobFormState
}

function parseFieldErrors(message: string): JobFieldErrors | null {
  try {
    const v = JSON.parse(message) as unknown
    return v && typeof v === 'object' ? (v as JobFieldErrors) : null
  } catch {
    return null
  }
}

function Form({ mode, jobName }: { mode: 'create' | 'update'; jobName: string }) {
  const list = useJobs((s) => s.list)
  const [loaded, setLoaded] = useState<Loaded | null>(
    mode === 'create' ? { basis: null, initial: initialForm('', null) } : null,
  )
  const [form, setForm] = useState<JobFormState>(() => initialForm(jobName, null))
  const [touchedSteps, setTouchedSteps] = useState(false)
  const [server, setServer] = useState<JobFieldErrors>({})
  const [stale, setStale] = useState(false)
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const keepRef = useRef<HTMLButtonElement>(null)

  const fetchJob = useCallback(async (): Promise<Loaded | null> => {
    let r
    try {
      r = await invoke('jobs.get', { name: jobName })
    } catch {
      return null
    }
    if (!r.ok || !r.value?.settings) return null
    return {
      basis: r.value.text,
      initial: initialForm(jobName, { settings: r.value.settings, steps: r.value.steps }),
    }
  }, [jobName])

  useEffect(() => {
    if (mode === 'create') return
    let live = true
    void fetchJob().then((l) => {
      if (!live) return
      if (!l) {
        notifications.show({
          color: 'red',
          message: `Could not read jobs/${jobName}/job.md. Check that it exists, then try again.`,
        })
        closeJobForm()
        return
      }
      setLoaded(l)
      setForm(l.initial)
    })
    return () => {
      live = false
    }
  }, [mode, jobName, fetchJob])

  useEffect(() => {
    if (confirming) keepRef.current?.focus()
  }, [confirming])

  const names = useMemo(() => (list ?? []).map((j) => j.name), [list])
  const errors = useMemo(() => formErrors(form, mode, names), [form, mode, names])
  const dirty = loaded !== null && isDirty(form, loaded.initial)
  const valid = Object.keys(errors).length === 0 && Object.keys(server).length === 0
  const canSave = loaded !== null && valid && !stale && !pending && (mode === 'create' || dirty)

  const edit = (patch: Partial<JobFormState>): void => {
    setServer({})
    setForm((f) => ({ ...f, ...patch }))
  }

  const submit = useCallback(async (): Promise<void> => {
    if (!loaded || !canSave) return
    setPending(true)
    const name = form.name
    let r
    try {
      r = await invoke('jobs.save', { name, mode, basis: loaded.basis, ...toSaveInput(form) })
    } catch {
      r = null
    }
    setPending(false)
    if (r?.ok) {
      notifications.show({ color: 'green', message: `Saved jobs/${name}/job.md.`, autoClose: 4000 })
      closeJobForm()
      void loadJobs()
      return
    }
    const code = r && !r.ok ? r.error.code : 'unknown'
    if (code === 'changed-on-disk') setStale(true)
    else if (code === 'already-exists') setServer({ name: JOB_COPY.nameTaken(name) })
    else if (code === 'invalid-input') {
      const fields = parseFieldErrors(r && !r.ok ? r.error.message : '')
      setServer(fields ?? { steps: 'Could not save. Check the fields and try again.' })
    } else {
      notifications.show({
        color: 'red',
        message: `Could not save jobs/${name}/job.md. Try again.`,
        autoClose: 8000,
      })
    }
  }, [loaded, canSave, form, mode])

  // The quit guard saves through the latest closure, and the entry exists only while dirty.
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    if (!dirty) return
    return registerDirty('job-form', {
      label: `Job ${form.name || 'new'}`,
      save: async () => {
        await submitRef.current()
        if (jobsStore.getState().form !== null) throw new Error('The job was not saved.')
      },
    })
  }, [dirty, form.name])

  const reload = async (): Promise<void> => {
    const l = await fetchJob()
    if (!l) return
    setLoaded(l)
    setForm(l.initial)
    setServer({})
    setStale(false)
  }
  const keepEditing = async (): Promise<void> => {
    const l = await fetchJob()
    if (!l) return
    // Adopt the fresh text as basis and baseline; only fields the user changed keep their value.
    const old = loaded?.initial ?? l.initial
    setLoaded(l)
    setForm((f) => mergeFresh(f, old, l.initial))
    setStale(false)
  }

  const run = async (): Promise<void> => {
    let ok = false
    try {
      ok = (await invoke('jobs.run', { name: jobName })).ok
    } catch {
      ok = false
    }
    if (ok) {
      notifications.show({ color: 'green', message: `Started ${jobName}.`, autoClose: 4000 })
      setTimeout(() => void loadJobs(), 2000)
    } else {
      notifications.show({
        color: 'red',
        message: `Could not start ${jobName}. Check that bun is installed and try again.`,
        autoClose: 8000,
      })
    }
  }

  const sessionFile = list?.find((j) => j.name === jobName)?.sessionFile ?? null
  const openLast = (): void => {
    if (!sessionFile) return
    openPlace(placeOf('chat', { chat: sessionFile }))
    closeJobForm()
  }

  const remove = async (): Promise<void> => {
    let ok = false
    try {
      ok = (await invoke('jobs.delete', { name: jobName })).ok
    } catch {
      ok = false
    }
    if (ok) {
      notifications.show({ color: 'green', message: `Deleted jobs/${jobName}.`, autoClose: 4000 })
      closeJobForm()
      void loadJobs()
    } else {
      setConfirming(false)
      notifications.show({
        color: 'red',
        message: `Could not delete jobs/${jobName}. Try again.`,
        autoClose: 8000,
      })
    }
  }

  const shown = (key: keyof JobFieldErrors, text: string): string | undefined => {
    if (key === 'steps' && !touchedSteps && !server.steps) return undefined
    if (text === '' && key !== 'steps') return server[key]
    return server[key] ?? errors[key]
  }
  const nameErr = form.name === '' ? server.name : (server.name ?? errors.name)

  return (
    <div
      className="eva-job-form"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.metaKey) {
          e.preventDefault()
          void submit()
        }
      }}
    >
      {stale ? (
        <div className="eva-job-banner" role="alert" data-testid="job-form-stale">
          <IconAlertTriangle size={16} aria-hidden="true" />
          <span>{`jobs/${jobName}/job.md changed on disk since you opened it. Your edits were not saved.`}</span>
          <span className="eva-job-banner-actions">
            <Button
              size="compact-sm"
              variant="default"
              data-testid="job-form-reload"
              onClick={() => void reload()}
            >
              Reload from disk
            </Button>
            <Button
              size="compact-sm"
              variant="default"
              data-testid="job-form-keep-editing"
              onClick={() => void keepEditing()}
            >
              Keep editing
            </Button>
          </span>
        </div>
      ) : null}
      {mode === 'create' ? (
        <TextInput
          label="Name"
          placeholder="new-job"
          data-autofocus
          data-testid="job-name"
          value={form.name}
          error={nameErr}
          onChange={(e) => edit({ name: e.currentTarget.value })}
          classNames={{ input: 'eva-job-mono' }}
        />
      ) : null}
      <div className="eva-job-field">
        <Text size="sm" fw={500} component="label" id="job-schedule-label">
          Schedule
        </Text>
        <SegmentedControl
          aria-labelledby="job-schedule-label"
          data-testid="job-schedule"
          data={[
            { value: 'every', label: 'Every' },
            { value: 'manual', label: 'Manual' },
          ]}
          value={form.schedule}
          onChange={(v) => edit({ schedule: v as ScheduleMode })}
        />
      </div>
      {form.schedule === 'every' ? (
        <TextInput
          label="Interval"
          placeholder="Manual (e.g. 10m, 2h, 1d)"
          data-testid="job-every"
          value={form.every}
          error={shown('every', form.every)}
          onChange={(e) => edit({ every: e.currentTarget.value })}
          classNames={{ input: 'eva-job-mono' }}
        />
      ) : null}
      <TextInput
        label="Max run"
        placeholder="Runner default"
        data-testid="job-max-run"
        value={form.maxRun}
        error={shown('maxRun', form.maxRun)}
        onChange={(e) => edit({ maxRun: e.currentTarget.value })}
        classNames={{ input: 'eva-job-mono' }}
      />
      <TextInput
        label="Keep"
        description={JOB_COPY.keepHelp}
        placeholder="30m"
        data-testid="job-keep"
        value={form.keep}
        error={shown('keep', form.keep)}
        onChange={(e) => edit({ keep: e.currentTarget.value })}
        classNames={{ input: 'eva-job-mono' }}
      />
      <Switch
        label="Enabled"
        data-testid="job-form-enabled"
        checked={form.enabled}
        onChange={(e) => edit({ enabled: e.currentTarget.checked })}
      />
      <Textarea
        label="Steps"
        autosize
        minRows={6}
        maxRows={16}
        data-testid="job-steps"
        value={form.steps}
        error={shown('steps', form.steps)}
        onChange={(e) => edit({ steps: e.currentTarget.value })}
        onBlur={() => setTouchedSteps(true)}
        classNames={{ input: 'eva-job-mono' }}
      />
      {confirming ? (
        <div className="eva-job-confirm" data-testid="job-delete-panel">
          <Text fw={600}>{`Delete jobs/${jobName} and everything in it?`}</Text>
          <Text size="xs" c="dimmed">
            This removes the folder from the Eva repo. Running processes are not stopped.
          </Text>
          <div className="eva-job-footer">
            <Button
              variant="default"
              ref={keepRef}
              data-testid="job-delete-keep"
              onClick={() => setConfirming(false)}
            >
              Keep
            </Button>
            <Button color="red" data-testid="job-delete-confirm" onClick={() => void remove()}>
              Delete job
            </Button>
          </div>
        </div>
      ) : (
        <div className="eva-job-footer">
          {mode === 'update' ? (
            <div className="eva-job-footer-left">
              <Tooltip
                label="Starts job-run.ts now; the saved job.md is what runs"
                openDelay={300}
                zIndex={TIP_Z}
              >
                <Button variant="default" data-testid="job-run-now" onClick={() => void run()}>
                  Run now
                </Button>
              </Tooltip>
              <Tooltip label="No run yet" disabled={sessionFile !== null} zIndex={TIP_Z}>
                <span>
                  <Button
                    variant="default"
                    data-testid="job-open-last"
                    disabled={sessionFile === null}
                    onClick={openLast}
                  >
                    Open last session
                  </Button>
                </span>
              </Tooltip>
              <Button
                variant="outline"
                color="red"
                data-testid="job-delete"
                onClick={() => setConfirming(true)}
              >
                Delete
              </Button>
            </div>
          ) : (
            <span />
          )}
          <div className="eva-job-footer-right">
            <Button variant="default" data-testid="job-discard" onClick={closeJobForm}>
              Discard changes
            </Button>
            <Button
              disabled={!canSave}
              data-testid="job-save"
              onClick={() => void submit()}
              rightSection={pending ? null : <Kbd style={{ opacity: 0.7 }}>⌘↵</Kbd>}
            >
              {pending ? 'Saving' : mode === 'create' ? 'Create job' : 'Save job'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function JobForm() {
  const form = useJobs((s) => s.form)
  if (!form) return null
  const mode = form.mode === 'create' ? 'create' : 'update'
  const name = form.mode === 'edit' ? form.name : ''
  return (
    <EvaModal
      opened
      onClose={closeJobForm}
      size={560}
      testid="job-form"
      title={form.mode === 'edit' ? <span className="eva-job-mono">{form.name}</span> : 'New job'}
    >
      <Form key={`${mode}:${name}`} mode={mode} jobName={name} />
    </EvaModal>
  )
}
