import { describe, expect, it } from 'vitest'
import { JOB_COPY } from '@evaos/eva-core/model/jobs'
import { formErrors, initialForm, isDirty, mergeFresh, toSaveInput } from './job-form-model'

const loaded = (every: string) => ({
  settings: { every, enabled: true, maxRun: '', keep: '' },
  steps: 'Do it\n',
})

describe('job form model', () => {
  it('maps a loaded job and tracks dirtiness', () => {
    const every = initialForm('nightly', loaded('2h'))
    expect(every.schedule).toBe('every')
    expect(initialForm('x', loaded('')).schedule).toBe('manual')
    expect(isDirty(every, every)).toBe(false)
    expect(isDirty(every, { ...every, maxRun: '5m' })).toBe(true)
    const manual = { ...every, schedule: 'manual' as const }
    expect(toSaveInput(manual).settings.every).toBe('')
    expect(toSaveInput(every).settings.every).toBe('2h')
  })

  it('validates with the runner rules', () => {
    const base = { ...initialForm('new-job', null), steps: 'a' }
    expect(formErrors({ ...base, name: 'Nightly' }, 'create', []).name).toBe(JOB_COPY.nameRule)
    expect(formErrors({ ...base, name: 'Nightly' }, 'update', []).name).toBeUndefined()
    expect(formErrors({ ...base, name: 'nightly' }, 'create', ['nightly']).name).toBe(
      JOB_COPY.nameTaken('nightly'),
    )
    expect(formErrors({ ...base, every: '0m' }, 'create', []).every).toBe(JOB_COPY.zero)
    expect(formErrors({ ...base, maxRun: 'x' }, 'create', []).maxRun).toBe(JOB_COPY.duration)
    expect(formErrors({ ...base, steps: '  ' }, 'create', []).steps).toBe(JOB_COPY.steps)
    expect(formErrors({ ...base, keep: '0', maxRun: '' }, 'create', [])).toEqual({})
    expect(formErrors({ ...base, schedule: 'manual', every: 'junk' }, 'create', [])).toEqual({})
  })
})

describe('mergeFresh', () => {
  const settings = { every: '2h', enabled: true, maxRun: '', keep: '' }
  const old = initialForm('nightly', { settings, steps: 'one\n' })
  const fresh = initialForm('nightly', {
    settings: { ...settings, keep: '1h', enabled: false },
    steps: 'one\ntwo\n',
  })
  it('keeps user-changed fields and adopts external edits to the rest', () => {
    const form = { ...old, maxRun: '5m' }
    const merged = mergeFresh(form, old, fresh)
    expect(merged).toMatchObject({ maxRun: '5m', keep: '1h', enabled: false, steps: 'one\ntwo\n' })
    expect(isDirty(merged, fresh)).toBe(true)
    expect(isDirty(mergeFresh(old, old, fresh), fresh)).toBe(false)
  })
  it('keeps user-edited steps over fresh steps', () => {
    expect(mergeFresh({ ...old, steps: 'mine\n' }, old, fresh).steps).toBe('mine\n')
  })
})
