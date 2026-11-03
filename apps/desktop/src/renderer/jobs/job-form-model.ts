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

/**
 * Fields the user changed since `oldInitial` keep their typed value; every other field takes the
 * fresh disk value, so saving never rewrites external edits to fields the user did not touch.
 */
export function mergeFresh(
  form: JobFormState,
  oldInitial: JobFormState,
  fresh: JobFormState,
): JobFormState {
  const same = (k: keyof JobFormState): boolean => form[k] === oldInitial[k]
  const schedule = same('schedule') && same('every')
  return {
    name: fresh.name,
    schedule: schedule ? fresh.schedule : form.schedule,
    every: schedule ? fresh.every : form.every,
    maxRun: same('maxRun') ? fresh.maxRun : form.maxRun,
    keep: same('keep') ? fresh.keep : form.keep,
    enabled: same('enabled') ? fresh.enabled : form.enabled,
    steps: same('steps') ? fresh.steps : form.steps,
  }
}
