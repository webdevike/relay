import { describe, expect, it } from 'vitest'
import {
  agoLabel,
  JOB_COPY,
  JobDoc,
  nameError,
  nextDue,
  parseDuration,
  scheduleLabel,
  untilLabel,
  validateJob,
  type JobSettings,
} from './jobs'

const JOB =
  '---\nevery: 10m\nowner: isaac\nenabled: false\n# note\nmax_run: "5m"\n---\n1. Run `bun $JOB/x.ts`.\n2. Reply.\n'

const BLANK: JobSettings = { every: '', enabled: true, maxRun: '', keep: '' }

describe('JobDoc round trip', () => {
  it('is byte identical for untouched docs', () => {
    for (const text of [JOB, 'just steps\n', '---\nevery: 5m\n---no newline body', '']) {
      const doc = JobDoc.parse(text)
      expect(doc.render()).toBe(text)
      expect(doc.apply(doc.settings()).render()).toBe(text)
    }
  })
})

describe('JobDoc read', () => {
  it('uses the runner key regex, value cleanup and last-wins', () => {
    const doc = JobDoc.parse('---\nevery: 1m\nevery: "2h"\nscript: ./go.sh\n---\nsteps')
    expect(doc.get('every')).toBe('2h')
    expect(doc.get('script')).toBe('./go.sh')
    expect(doc.get('missing')).toBeNull()
    expect(doc.extraKeys()).toEqual(['script'])
    expect(doc.steps()).toBe('steps')
  })
  it('only a literal false disables', () => {
    const enabled = (t: string) => JobDoc.parse(t).settings().enabled
    expect(enabled('steps')).toBe(true)
    expect(enabled('---\nenabled: no\n---\nx')).toBe(true)
    expect(enabled('---\nenabled: False\n---\nx')).toBe(true)
    expect(enabled('---\nenabled: false\n---\nx')).toBe(false)
    expect(enabled('---\nenabled: "false"\n---\nx')).toBe(false)
  })
  it('strips quotes in settings', () => {
    expect(JobDoc.parse(JOB).settings().maxRun).toBe('5m')
  })
})

describe('JobDoc apply', () => {
  it('rewrites only changed lines and keeps comments, unknown keys and body', () => {
    const doc = JobDoc.parse(JOB)
    const next = doc.apply({ ...doc.settings(), every: '2h', enabled: true, keep: '45m' })
    expect(next.render()).toBe(
      '---\nevery: 2h\nowner: isaac\nenabled: true\n# note\nmax_run: "5m"\nkeep: 45m\n---\n1. Run `bun $JOB/x.ts`.\n2. Reply.\n',
    )
  })
  it('drops later duplicates of a changed key', () => {
    const doc = JobDoc.parse('---\nevery: 2h\nowner: x\nevery: 1h\n---\nb\n')
    // last wins, so settings read 1h; change to 3h
    const next = doc.apply({ ...doc.settings(), every: '3h' })
    expect(next.render()).toBe('---\nevery: 3h\nowner: x\n---\nb\n')
  })
  it('removes keys with empty values', () => {
    const doc = JobDoc.parse(JOB)
    const next = doc.apply({ every: ' ', enabled: false, maxRun: '', keep: '' })
    expect(next.render()).toBe(
      '---\nowner: isaac\nenabled: false\n# note\n---\n1. Run `bun $JOB/x.ts`.\n2. Reply.\n',
    )
  })
  it('appends a new key before the closing fence', () => {
    const doc = JobDoc.parse('---\nevery: 5m\n---\nbody\n')
    expect(doc.apply({ ...doc.settings(), maxRun: '10m' }).render()).toBe(
      '---\nevery: 5m\nmax_run: 10m\n---\nbody\n',
    )
  })
})

describe('JobDoc setEnabled', () => {
  it('writes false, and true only rewrites an existing line', () => {
    const doc = JobDoc.parse('---\nevery: 1m\n---\nsteps')
    expect(doc.setEnabled(true).render()).toBe('---\nevery: 1m\n---\nsteps')
    const off = doc.setEnabled(false)
    expect(off.render()).toBe('---\nevery: 1m\nenabled: false\n---\nsteps')
    expect(off.setEnabled(true).render()).toBe('---\nevery: 1m\nenabled: true\n---\nsteps')
  })
})

describe('JobDoc create', () => {
  it('renders settings then steps with a trailing newline', () => {
    const doc = JobDoc.parse('')
      .apply({ every: '10m', enabled: true, maxRun: '', keep: '' })
      .withSteps('1. Ping.')
    expect(doc.render()).toBe('---\nevery: 10m\n---\n1. Ping.\n')
  })
  it('renders no frontmatter when nothing is set', () => {
    expect(JobDoc.parse('').apply(BLANK).withSteps('go\n').render()).toBe('go\n')
  })
})

describe('parseDuration', () => {
  it('accepts runner syntax', () => {
    expect(parseDuration('10m')).toBe(600_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1d')).toBe(86_400_000)
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration(' 5 ')).toBe(300_000)
    expect(parseDuration('7 m')).toBe(420_000)
    expect(parseDuration('0')).toBe(0)
  })
  it('rejects bad input', () => {
    for (const bad of ['1.5h', 'h', '-1m', '', '5x']) expect(parseDuration(bad)).toBeNull()
  })
})

describe('validateJob', () => {
  const base = {
    mode: 'create' as const,
    settings: BLANK,
    steps: 'x',
    existingNames: [] as string[],
  }
  it('checks names', () => {
    expect(validateJob({ ...base, name: '0-nightly' }).name).toBeUndefined()
    expect(validateJob({ ...base, name: 'Nightly' }).name).toBe(JOB_COPY.nameRule)
    expect(validateJob({ ...base, name: 'my_job' }).name).toBe(JOB_COPY.nameRule)
    expect(validateJob({ ...base, name: 'a', existingNames: ['a'] }).name).toBe(
      JOB_COPY.nameTaken('a'),
    )
    expect(
      validateJob({ ...base, mode: 'update', name: 'a', existingNames: ['a'] }).name,
    ).toBeUndefined()
    expect(nameError('')).toBe(JOB_COPY.nameRule)
    expect(nameError('ok-1')).toBeNull()
  })
  it('checks durations and steps', () => {
    const s = (p: Partial<JobSettings>) => ({ ...BLANK, ...p })
    expect(validateJob({ ...base, name: 'a', settings: s({ every: '0m' }) }).every).toBe(
      JOB_COPY.zero,
    )
    expect(validateJob({ ...base, name: 'a', settings: s({ maxRun: '0' }) }).maxRun).toBe(
      JOB_COPY.zero,
    )
    expect(validateJob({ ...base, name: 'a', settings: s({ keep: '0' }) }).keep).toBeUndefined()
    expect(validateJob({ ...base, name: 'a', settings: s({ every: 'abc' }) }).every).toBe(
      JOB_COPY.duration,
    )
    expect(validateJob({ ...base, name: 'a', steps: '  \n' }).steps).toBe(JOB_COPY.steps)
    expect(validateJob({ ...base, name: 'a' })).toEqual({})
  })
})

describe('labels', () => {
  it('schedule and next due', () => {
    expect(scheduleLabel('2h')).toBe('Every 2h')
    expect(scheduleLabel(null)).toBe('Manual')
    expect(scheduleLabel('0m')).toBe('Manual')
    const on = { ...BLANK, every: '10m' }
    expect(nextDue(on, 1000)).toBe(601_000)
    expect(nextDue(on, null)).toBe(0)
    expect(nextDue(BLANK, 1000)).toBeNull()
    expect(nextDue({ ...on, enabled: false }, 1000)).toBeNull()
  })
  it('ago and until', () => {
    const now = 10_000_000_000
    const m = 60_000
    expect(agoLabel(now - 30_000, now)).toBe('just now')
    expect(agoLabel(now - 59 * m, now)).toBe('59m ago')
    expect(agoLabel(now - 60 * m, now)).toBe('1h ago')
    expect(agoLabel(now - 2879 * m, now)).toBe('47h ago')
    expect(agoLabel(now - 2880 * m, now)).toBe('2d ago')
    expect(untilLabel(now - 1, now)).toBe('due now')
    expect(untilLabel(now + 30_000, now)).toBe('in under a minute')
    expect(untilLabel(now + 120 * m, now)).toBe('in 2h')
  })
  it('copy has no em dashes', () => {
    expect(JSON.stringify(JOB_COPY) + JOB_COPY.nameTaken('x')).not.toContain(
      String.fromCharCode(8212),
    )
  })
})
