import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isLockLive, listJobs } from './jobs-read'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobs-read-'))
  mkdirSync(join(root, 'jobs/.runs'), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function job(name: string, text: string | null): void {
  mkdirSync(join(root, 'jobs', name), { recursive: true })
  if (text !== null) writeFileSync(join(root, 'jobs', name, 'job.md'), text)
}
function run(name: string, id: string, status: object): void {
  const dir = join(root, 'jobs/.runs', name, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'status.json'), JSON.stringify(status))
}
const NOW = 1_760_000_000_000
const dead = { pidAlive: () => false }

describe('listJobs', () => {
  it('sorts by name and skips dot, invalid and job.md-less folders', () => {
    job('zeta', 'z\n')
    job('alpha', 'a\n')
    job('.hidden', 'x\n')
    job('Bad_Name', 'x\n')
    job('no-file', null)
    expect(listJobs(root, NOW, dead).map((j) => j.name)).toEqual(['alpha', 'zeta'])
  })
  it('returns an empty list without a jobs folder', () => {
    rmSync(join(root, 'jobs'), { recursive: true })
    expect(listJobs(root, NOW)).toEqual([])
  })

  it('reads last-run and maps the latest status', () => {
    job('a', 'x\n')
    mkdirSync(join(root, 'jobs/.runs/a'), { recursive: true })
    writeFileSync(join(root, 'jobs/.runs/a/last-run'), '1759741200000\n')
    run('a', '2026-10-05T090000', { state: 'failed' })
    run('a', '2026-10-06T090000', { state: 'done', note: 'omp exit 0' })
    mkdirSync(join(root, 'jobs/.runs/a/not-a-run-id'))
    const [a] = listJobs(root, NOW, dead)
    expect(a!.lastRunAt).toBe(1_759_741_200_000)
    expect(a!.runState).toBe('ok')
    expect(a!.runNote).toBe('omp exit 0')
  })
  it('ignores last-run values at or below zero', () => {
    job('a', 'x\n')
    mkdirSync(join(root, 'jobs/.runs/a'), { recursive: true })
    writeFileSync(join(root, 'jobs/.runs/a/last-run'), '0\n')
    expect(listJobs(root, NOW, dead)[0]!.lastRunAt).toBeNull()
    expect(listJobs(root, NOW, dead)[0]!.runState).toBe('never')
  })
  it('maps timeout and killed to failed and unknown states to other', () => {
    for (const [name, state] of [
      ['t', 'timeout'],
      ['k', 'killed'],
      ['r', 'running'],
      ['w', 'weird'],
    ] as const) {
      job(name, 'x\n')
      run(name, '2026-10-06T090000', { state })
    }
    const by = Object.fromEntries(listJobs(root, NOW, dead).map((j) => [j.name, j]))
    expect(by.t!.runState).toBe('failed')
    expect(by.k!.runState).toBe('failed')
    expect(by.r).toMatchObject({ runState: 'other', runStateRaw: 'running' })
    expect(by.w).toMatchObject({ runState: 'other', runStateRaw: 'weird' })
  })

  it('treats a live lock as running and ignores a dead one', () => {
    job('a', 'x\n')
    run('a', '2026-10-06T090000', { state: 'done' })
    writeFileSync(join(root, 'jobs/.runs/a.lock'), '4242 2026-10-06T09:00:00Z\n')
    expect(listJobs(root, NOW, { pidAlive: (p) => p === 4242 })[0]!.runState).toBe('running')
    expect(listJobs(root, NOW, dead)[0]!.runState).toBe('ok')
  })
  it('treats an unreadable lock as live', () => {
    job('a', 'x\n')
    mkdirSync(join(root, 'jobs/.runs/a.lock'))
    expect(listJobs(root, NOW, dead)[0]!.runState).toBe('running')
  })

  it('offers sessionFile only when it exists', () => {
    job('a', 'x\n')
    const file = join(root, 's.jsonl')
    run('a', '2026-10-06T090000', { state: 'done', sessionFile: file })
    expect(listJobs(root, NOW, { ...dead, fileExists: () => false })[0]!.sessionFile).toBeNull()
    expect(listJobs(root, NOW, { ...dead, fileExists: (p) => p === file })[0]!.sessionFile).toBe(
      file,
    )
  })

  it('derives description, schedule, next due and script', () => {
    job('a', '---\nevery: 10m\nmax_run: 5m\nkeep: 0\nscript: ./go.sh\n---\n\n  First line  \n2. next\n')
    job('b', '---\nevery: 10m\nenabled: false\n---\nsteps\n')
    job('c', '---\nevery: 0m\n---\n')
    mkdirSync(join(root, 'jobs/.runs/a'), { recursive: true })
    writeFileSync(join(root, 'jobs/.runs/a/last-run'), '1000\n')
    const by = Object.fromEntries(listJobs(root, NOW, dead).map((j) => [j.name, j]))
    expect(by.a).toMatchObject({
      description: 'First line',
      every: '10m',
      enabled: true,
      scheduled: true,
      maxRun: '5m',
      keep: '0',
      nextDueAt: 601_000,
      hasScript: true,
    })
    expect(by.b).toMatchObject({ enabled: false, scheduled: false, nextDueAt: null, hasScript: false })
    expect(by.c).toMatchObject({ description: null, scheduled: false, nextDueAt: null })
  })
})

describe('isLockLive', () => {
  it('parses the first token as a pid', () => {
    expect(isLockLive('77 x', (p) => p === 77)).toBe(true)
    expect(isLockLive('77 x', () => false)).toBe(false)
    expect(isLockLive('abc', () => true)).toBe(false)
    expect(isLockLive('0 x', () => true)).toBe(false)
  })
})
