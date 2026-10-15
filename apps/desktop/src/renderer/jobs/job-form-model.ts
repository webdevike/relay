import { validateJob, type JobFieldErrors, type JobSettings } from '@evaos/eva-core/model/jobs'

export type ScheduleMode = 'every' | 'manual'

export interface JobFormState {
  name: string
  schedule: ScheduleMode
  every: string
  maxRun: string
  keep: string
  enabled: boolean
  steps: string
}

export interface LoadedJob {
  settings: JobSettings
  steps: string
}

export function initialForm(name: string, loaded: LoadedJob | null): JobFormState {
  if (!loaded) {
    return {
      name,
      schedule: 'every',
      every: '',
      maxRun: '',
      keep: '',
      enabled: true,
      steps: '',
    }
  }
  const s = loaded.settings
  return {
    name,
    schedule: s.every.trim() === '' ? 'manual' : 'every',
    every: s.every,
    maxRun: s.maxRun,
    keep: s.keep,
    enabled: s.enabled,
    steps: loaded.steps,
  }
}

export function toSaveInput(f: JobFormState): { settings: JobSettings; steps: string } {
  return {
    settings: {
      every: f.schedule === 'manual' ? '' : f.every.trim(),
      enabled: f.enabled,
      maxRun: f.maxRun.trim(),
      keep: f.keep.trim(),
    },
    steps: f.steps,
  }
}

export function formErrors(
  f: JobFormState,
  mode: 'create' | 'update',
  existingNames: string[],
): JobFieldErrors {
  const { settings, steps } = toSaveInput(f)
  const errors = validateJob({ name: f.name, mode, settings, steps, existingNames })
  // The name of an existing job is not editable, so it is never re-validated.
  if (mode === 'update') delete errors.name
  return errors
}

export function isDirty(a: JobFormState, b: JobFormState): boolean {
  return (
    a.name !== b.name ||
    a.schedule !== b.schedule ||
    (a.schedule === 'every' && a.every.trim() !== b.every.trim()) ||
    a.maxRun.trim() !== b.maxRun.trim() ||
    a.keep.trim() !== b.keep.trim() ||
    a.enabled !== b.enabled ||
    a.steps !== b.steps
  )
}
