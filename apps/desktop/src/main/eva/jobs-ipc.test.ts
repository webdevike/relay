import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createEvaFs } from '@evaos/eva-core'
import { makeEvaFixture } from '../../../e2e/helpers/eva-fixture'
import { jobsDelete, jobsGet, jobsList, jobsRun, jobsSave, jobsSetEnabled } from './jobs-ipc'

const fixtures: Array<{ cleanup(): void }> = []

function tmpRoot(): string {
  const fx = makeEvaFixture()
  fixtures.push(fx)
  return fx.root
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})

const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')
const clock = { now: () => new Date('2026-10-15T12:00:00Z') }
const settings = { every: '2h', enabled: true, maxRun: '20m', keep: '30m' }

describe('jobs handlers', () => {
  it('lists the fixture jobs', () => {
    const { jobs } = jobsList(tmpRoot(), clock)
    expect(jobs.map((j) => j.name)).toEqual([
      'broken',
      'manual-check',
      'nightly',
      'script-job',
      'stale-lock',
      'weekly-digest',
    ])
    expect(jobs.filter((j) => j.scheduled)).toHaveLength(4)
    const by = (n: string) => jobs.find((j) => j.name === n)!
    expect(by('nightly').runState).toBe('ok')
    expect(by('nightly').lastRunAt).not.toBeNull()
    expect(by('broken').runState).toBe('failed')
    expect(by('stale-lock').runState).not.toBe('running')
    expect(by('script-job').hasScript).toBe(true)
    expect(by('script-job').runState).toBe('never')
  })

  it('gets the full text, settings and steps', () => {
    const got = jobsGet(tmpRoot(), 'nightly')
    expect(got.settings).toEqual(settings)
    expect(got.steps).toBe('Run the nightly steps.\n')
    expect(got.text).toContain('# comment line')
    expect(() => jobsGet(tmpRoot(), 'nope')).toThrow(/not found/)
  })

  it('updates only the changed line and refuses a stale basis', async () => {
    const root = tmpRoot()
    const evaFs = createEvaFs({ root })
    const before = read(root, 'jobs/nightly/job.md')
    const res = await jobsSave(root, evaFs, {
      name: 'nightly',
      mode: 'update',
      basis: before,
      settings: { ...settings, every: '3h' },
      steps: 'Run the nightly steps.\n',
    })
    expect(res.changed).toBe(true)
    const after = read(root, 'jobs/nightly/job.md')
    const a = before.split('\n')
    const b = after.split('\n')
    expect(b).toHaveLength(a.length)
    expect(b.filter((l, i) => l !== a[i])).toEqual(['every: 3h'])
    expect(after).toContain('# comment line')

    await expect(
      jobsSave(root, evaFs, {
        name: 'nightly',
        mode: 'update',
        basis: before,
        settings: { ...settings, every: '4h' },
        steps: 'x',
      }),
    ).rejects.toMatchObject({ code: 'changed-on-disk' })
    expect(read(root, 'jobs/nightly/job.md')).toBe(after)

    const mtime = fs.statSync(path.join(root, 'jobs/nightly/job.md')).mtimeMs
    const same = await jobsSave(root, evaFs, {
      name: 'nightly',
      mode: 'update',
      basis: after,
      settings: { ...settings, every: '3h' },
      steps: 'Run the nightly steps.\n',
    })
    expect(same.changed).toBe(false)
    expect(fs.statSync(path.join(root, 'jobs/nightly/job.md')).mtimeMs).toBe(mtime)
  })

  it('keeps the script key on update', async () => {
    const root = tmpRoot()
    const evaFs = createEvaFs({ root })
    const before = read(root, 'jobs/script-job/job.md')
    await jobsSave(root, evaFs, {
      name: 'script-job',
      mode: 'update',
      basis: before,
      settings: { every: '2h', enabled: true, maxRun: '', keep: '' },
      steps: 'Runs a script instead of omp.\n',
    })
    expect(read(root, 'jobs/script-job/job.md')).toContain('script: tools/report.ts')
  })

  it('creates once, then refuses, and rejects invalid fields as JSON', async () => {
    const root = tmpRoot()
    const evaFs = createEvaFs({ root })
    const input = {
      name: 'new-job',
      mode: 'create' as const,
      basis: null,
      settings: { every: '1h', enabled: true, maxRun: '', keep: '' },
      steps: 'Do it',
    }
    await jobsSave(root, evaFs, input)
    expect(read(root, 'jobs/new-job/job.md')).toBe('---\nevery: 1h\n---\nDo it\n')
    await expect(jobsSave(root, evaFs, input)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(
      jobsSave(root, evaFs, {
        ...input,
        name: 'other',
        settings: { ...input.settings, every: 'soon' },
        steps: '  ',
      }),
    ).rejects.toSatisfy((e: Error) => {
      const f = JSON.parse(e.message) as Record<string, string>
      return typeof f.every === 'string' && typeof f.steps === 'string'
    })
  })

  it('create refuses an existing folder with already-exists', async () => {
    const root = tmpRoot()
    const evaFs = createEvaFs({ root })
    fs.mkdirSync(path.join(root, 'jobs', 'ghost'))
    await expect(
      jobsSave(root, evaFs, {
        name: 'ghost',
        mode: 'create',
        basis: null,
        settings: { every: '', enabled: true, maxRun: '', keep: '' },
        steps: 'x',
      }),
    ).rejects.toMatchObject({ code: 'already-exists' })
  })

  it('setEnabled changes only the enabled line', async () => {
    const root = tmpRoot()
    const evaFs = createEvaFs({ root })
    const before = read(root, 'jobs/nightly/job.md')
    await jobsSetEnabled(evaFs, 'nightly', false)
    const after = read(root, 'jobs/nightly/job.md')
    expect(after.split('\n').filter((l) => !before.split('\n').includes(l))).toEqual([
      'enabled: false',
    ])
    await jobsSetEnabled(evaFs, 'weekly-digest', true)
    expect(read(root, 'jobs/weekly-digest/job.md')).toContain('enabled: true')
    expect(read(root, 'jobs/weekly-digest/job.md')).not.toContain('enabled: false')
  })

  it('delete removes the job folder and keeps its run history', async () => {
    const root = tmpRoot()
    const evaFs = createEvaFs({ root })
    const hadRuns = fs.existsSync(path.join(root, 'jobs/.runs/broken'))
    await jobsDelete(evaFs, 'broken')
    expect(fs.existsSync(path.join(root, 'jobs/broken'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'jobs/.runs/broken'))).toBe(hadRuns)
  })

  it('run calls the spawner for a known job only', async () => {
    const root = tmpRoot()
    const calls: string[] = []
    await expect(jobsRun(root, 'nightly', async (n) => void calls.push(n))).resolves.toEqual({
      started: true,
    })
    expect(calls).toEqual(['nightly'])
    await expect(jobsRun(root, 'nope', async () => {})).rejects.toMatchObject({
      code: 'not-found',
    })
  })
})
